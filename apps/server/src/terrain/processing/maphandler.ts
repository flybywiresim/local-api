import { GPU, IKernelRunShortcut, KernelOutput, Texture } from 'gpu.js';
import * as sharp from 'sharp';
import { readFile } from 'fs/promises';
import { parentPort } from 'worker_threads';
import { AircraftStatus, NavigationDisplay, PositionData, TerrainRenderingMode } from '../communication/types';
import { TerrainMap } from '../fileformat/terrainmap';
import { Worldmap } from '../mapdata/worldmap';
import { deg2rad, distanceWgs84, fastFlatten, rad2deg } from './generic/helper';
import { createLocalElevationMap } from './gpu/elevationmap';
import { normalizeHeading, projectWgs84 } from './gpu/helper';
import {
    calculateNormalModeGreenThresholds,
    calculateNormalModeWarningThresholds,
    calculatePeaksModeThresholds,
    renderNavigationDisplay,
    renderNormalMode,
    renderPeaksMode,
    drawDensityPixel,
} from './gpu/rendering';
import {
    HistogramConstants,
    LocalElevationMapConstants,
    NavigationDisplayConstants,
} from './gpu/interfaces';
import { createElevationHistogram, createLocalElevationHistogram } from './gpu/statistics';
import { uploadTextureData } from './gpu/upload';
import { NavigationDisplayData, TerrainLevelMode } from './navigationdisplaydata';
import { SimConnect } from '../communication/simconnect';
import { createArcModePatternMap } from './gpu/patterns/arcmode';
import { ThreadLogger } from './logging/threadlogger';
import { Logger } from './logging/logger';
import { NavigationDisplayThresholdsDto } from '../dto/navigationdisplaythresholds.dto';

// execution parameters
const GpuProcessingActive = true;

// mathematical conversion constants
const FeetPerNauticalMile = 6076.12;
const ThreeNauticalMilesInFeet = 18228.3;
const NauticalMilesToMetres = 1852;

// map grid creation
const InvalidElevation = 32767;
const UnknownElevation = 32766;
const WaterElevation = -1;
const DefaultTileSize = 300;

// histogram parameters
const HistogramBinRange = 100;
const HistogramMinimumElevation = -500; // some areas in the world are below water level
const HistogramMaximumElevation = 29040; // mount everest
const HistogramBinCount = Math.ceil((HistogramMaximumElevation - HistogramMinimumElevation + 1) / HistogramBinRange);
const HistogramPatchSize = 128;

// rendering parameters
const RenderingMaxPixelWidth = 768;
const RenderingScreenPixelHeight = 768;
const RenderingMapStartOffsetY = 128;
const RenderingArcModePixelWidth = 756;
const RenderingArcModePixelHeight = 492;
const RenderingRoseModePixelWidth = 678;
const RenderingRoseModePixelHeight = 250;
const RenderingMaxPixelHeight = Math.max(RenderingArcModePixelHeight, RenderingRoseModePixelHeight);
const RenderingCutOffAltitudeMinimimum = 200;
const RenderingCutOffAltitudeMaximum = 400;
const RenderingLowerPercentile = 0.85;
const RenderingUpperPercentile = 0.95;
const RenderingFlatEarthThreshold = 100;
const RenderingMaxAirportDistance = 4.0;
const RenderingNormalModeLowDensityGreenOffset = 2000;
const RenderingNormalModeHighDensityGreenOffset = 1000;
const RenderingNormalModeHighDensityYellowOffset = 1000;
const RenderingNormalModeHighDensityRedOffset = 2000;
const RenderingGearDownOffset = 250;
const RenderingNonGearDownOffset = 500;
const RenderingDensityPatchSize = 13;
const RenderingColorChannelCount = 4;
const RenderingMapTransitionDeltaTime = 40;
const RenderingMapTransitionDuration = 1000;
const RenderingMapUpdateTimeout = 1500;
const RenderingMapFrameValidityTime = RenderingMapTransitionDuration + RenderingMapUpdateTimeout;
const RenderingMapTransitionAngularStep = Math.round((90 / RenderingMapTransitionDuration) * RenderingMapTransitionDeltaTime);

class MapHandler {
    private simconnect: SimConnect = null;

    private worldmap: Worldmap = null;

    private gpu: GPU = null;

    private initialized = false;

    private currentGroundTruthPosition: PositionData = undefined;

    private uploadWorldMapToGPU: IKernelRunShortcut = null;

    private cachedElevationData: {
        gpuData: Texture,
        cpuData: Float32Array,
        cachedTiles: number,
    } = {
        gpuData: null,
        cpuData: null,
        cachedTiles: 0,
    }

    private uploadPatternMapToGPU: IKernelRunShortcut = null;

    private patternMap: Texture = null;

    private worldMapMetadata: {
        southwest: { latitude: number, longitude: number },
        northeast: { latitude: number, longitude: number },
        currentGridPosition: { x: number, y: number },
        minWidthPerTile: number,
        minHeightPerTile: number,
        width: number,
        height: number,
    } = {
        southwest: { latitude: -100, longitude: -190 },
        northeast: { latitude: -100, longitude: -190 },
        currentGridPosition: { x: 0, y: 0 },
        minWidthPerTile: 0,
        minHeightPerTile: 0,
        width: 0,
        height: 0,
    };

    private extractLocalElevationMap: IKernelRunShortcut = null;

    private localElevationHistogram: IKernelRunShortcut = null;

    private elevationHistogram: IKernelRunShortcut = null;

    private aircraftStatus: AircraftStatus = null;

    private navigationDisplayRendering: {
        [side: string]: {
            config: NavigationDisplay,
            timeout: NodeJS.Timeout,
            durationInterval: NodeJS.Timer,
            resetRenderingData: boolean,
            startupTimestamp: number,
            finalMap: IKernelRunShortcut,
            lastFrame: Uint8ClampedArray,
            lastTransitionData: {
                timestamp: number,
                thresholds: NavigationDisplayThresholdsDto,
                frames: Uint8ClampedArray[],
            },
        }
    } = {}

    private resetFrameData(side: string): void {
        this.navigationDisplayRendering[side].lastTransitionData.thresholds = null;
        this.navigationDisplayRendering[side].lastTransitionData.timestamp = 0;
        this.navigationDisplayRendering[side].lastTransitionData.frames = [];
        this.navigationDisplayRendering[side].lastFrame = null;
    }

    private cleanupMemory(): void {
        this.stopRendering();
        this.worldmap.resetInternalData();
        if (this.cachedElevationData.gpuData !== null) {
            this.cachedElevationData.gpuData.delete();
            this.cachedElevationData.gpuData = null;
        }
        this.cachedElevationData.cachedTiles = 0;
        this.cachedElevationData.cpuData = null;
        this.resetFrameData('L');
        this.resetFrameData('R');
    }

    private onConnectionLost(): void {
        this.cleanupMemory();
    }

    private onPositionUpdate(data: PositionData): void {
        this.updateGroundTruthPositionAndCachedTiles(data, false);
    }

    private onAircraftStatusUpdate(data: AircraftStatus, startup: boolean = false): void {
        if (this.aircraftStatus === null || data.navigationDisplayRenderingMode !== this.aircraftStatus.navigationDisplayRenderingMode || this.patternMap === null) {
            switch (data.navigationDisplayRenderingMode) {
            case TerrainRenderingMode.ArcMode:
                const patternData = createArcModePatternMap();
                this.patternMap = this.uploadPatternMapToGPU(patternData, RenderingMaxPixelWidth) as Texture;
                // some GPU drivers require the flush call to release internal memory
                if (GpuProcessingActive) this.uploadPatternMapToGPU.context.flush();
                if (startup) {
                    this.logging.info('ARC-mode rendering activated');
                }
                break;
            default:
                if (startup) {
                    this.logging.error('No known rendering mode selected');
                }
                break;
            }
        }

        this.aircraftStatus = data;
        this.configureNavigationDisplay('L', this.aircraftStatus.navigationDisplayCapt, startup);
        this.configureNavigationDisplay('R', this.aircraftStatus.navigationDisplayFO, startup);
    }

    private createKernels(): void {
        this.gpu = new GPU({ mode: 'gpu' });

        // register kernel to upload the map data
        this.uploadWorldMapToGPU = this.gpu
            .createKernel(uploadTextureData, {
                argumentTypes: { texture: 'Array', width: 'Integer' },
                dynamicArguments: true,
                dynamicOutput: true,
                pipeline: true,
                immutable: false,
                tactic: 'speed',
            });

        this.uploadPatternMapToGPU = this.gpu
            .createKernel(uploadTextureData, {
                argumentTypes: { texture: 'Array', width: 'Integer' },
                dynamicArguments: true,
                dynamicOutput: false,
                pipeline: true,
                immutable: false,
                tactic: 'speed',
            })
            .setOutput([RenderingMaxPixelWidth, RenderingMaxPixelHeight]);

        // register kernel to create the local map
        this.extractLocalElevationMap = this.gpu
            .createKernel(createLocalElevationMap, {
                dynamicArguments: true,
                dynamicOutput: false,
                pipeline: true,
                immutable: false,
                tactic: 'speed',
            })
            .setConstants<LocalElevationMapConstants>({
                unknownElevation: UnknownElevation,
                invalidElevation: InvalidElevation,
            })
            .setFunctions([
                deg2rad,
                normalizeHeading,
                rad2deg,
                projectWgs84,
            ])
            .setOutput([RenderingMaxPixelWidth, RenderingMaxPixelHeight]);

        this.localElevationHistogram = this.gpu
            .createKernel(createLocalElevationHistogram, {
                dynamicArguments: true,
                dynamicOutput: true,
                pipeline: true,
                immutable: false,
            })
            .setLoopMaxIterations(1000)
            .setConstants<HistogramConstants>({
                minimumElevation: HistogramMinimumElevation,
                invalidElevation: InvalidElevation,
                unknownElevation: UnknownElevation,
                waterElevation: WaterElevation,
                binRange: HistogramBinRange,
                binCount: HistogramBinCount,
                patchSize: HistogramPatchSize,
            });

        this.elevationHistogram = this.gpu
            .createKernel(createElevationHistogram, {
                dynamicArguments: true,
                pipeline: true,
                immutable: false,
            })
            .setLoopMaxIterations(500)
            .setOutput([HistogramBinCount]);

        /* create the sides */
        this.navigationDisplayRendering.L = {
            config: null,
            timeout: null,
            resetRenderingData: true,
            durationInterval: null,
            startupTimestamp: new Date().getTime(),
            finalMap: null,
            lastFrame: null,
            lastTransitionData: { timestamp: 0, thresholds: null, frames: [] },
        };
        this.navigationDisplayRendering.R = {
            config: null,
            timeout: null,
            resetRenderingData: true,
            durationInterval: null,
            // offset the rendering to have a more realistic bahaviour
            startupTimestamp: new Date().getTime() - 1500,
            finalMap: null,
            lastFrame: null,
            lastTransitionData: { timestamp: 0, thresholds: null, frames: [] },
        };

        for (const side in this.navigationDisplayRendering) {
            if (side in this.navigationDisplayRendering) {
                this.navigationDisplayRendering[side].finalMap = this.gpu
                    .createKernel(renderNavigationDisplay, {
                        dynamicArguments: true,
                        dynamicOutput: false,
                        pipeline: false,
                        immutable: false,
                    })
                    .setConstants<NavigationDisplayConstants>({
                        histogramBinRange: HistogramBinRange,
                        histogramMinElevation: HistogramMinimumElevation,
                        histogramBinCount: HistogramBinCount,
                        lowerPercentile: RenderingLowerPercentile,
                        upperPercentile: RenderingUpperPercentile,
                        flatEarthThreshold: RenderingFlatEarthThreshold,
                        invalidElevation: InvalidElevation,
                        unknownElevation: UnknownElevation,
                        waterElevation: WaterElevation,
                        normalModeLowDensityGreenOffset: RenderingNormalModeLowDensityGreenOffset,
                        normalModeHighDensityGreenOffset: RenderingNormalModeHighDensityGreenOffset,
                        normalModeHighDensityYellowOffset: RenderingNormalModeHighDensityYellowOffset,
                        normalModeHighDensityRedOffset: RenderingNormalModeHighDensityRedOffset,
                        maxImageWidth: RenderingMaxPixelWidth,
                        maxImageHeight: RenderingMaxPixelHeight,
                        densityPatchSize: RenderingDensityPatchSize,
                        patternMapWidth: RenderingMaxPixelWidth,
                        patternMapHeight: RenderingMaxPixelHeight,
                    })
                    .setFunctions([
                        calculateNormalModeGreenThresholds,
                        calculateNormalModeWarningThresholds,
                        calculatePeaksModeThresholds,
                        renderNormalMode,
                        renderPeaksMode,
                        drawDensityPixel,
                    ])
                    .setOutput([RenderingMaxPixelWidth * RenderingColorChannelCount, RenderingMaxPixelHeight + 1]);
            }
        }
    }

    private async readTerrainMap(): Promise<TerrainMap | undefined> {
        try {
            const buffer = await readFile('./terrain/terrain.map');
            // const buffer = await fileService.getFile('terrain/', 'terrain.map');
            this.logging.info(`Read MB of terrainmap: ${(Buffer.byteLength(buffer) / (1024 * 1024)).toFixed(2)}`);
            return new TerrainMap(buffer);
        } catch (err) {
            this.logging.warn('Did not find the terrain.map-file');
            this.logging.warn(err);
            return undefined;
        }
    }

    constructor(private logging: Logger) {
        this.readTerrainMap().then((terrainmap) => {
            this.simconnect = new SimConnect(logging);
            this.simconnect.addUpdateCallback('connectionLost', () => this.onConnectionLost());
            this.simconnect.addUpdateCallback('positionUpdate', (data: PositionData) => this.onPositionUpdate(data));
            this.simconnect.addUpdateCallback('aircraftStatusUpdate', (data: AircraftStatus) => this.onAircraftStatusUpdate(data));

            this.worldmap = new Worldmap(terrainmap);

            this.createKernels();

            // initial call precompile the kernels and reduce first reaction time
            const startupConfig: NavigationDisplay = {
                range: 10,
                arcMode: true,
                active: true,
                efisMode: 0,
                mapOffsetX: 0,
                mapWidth: RenderingMaxPixelWidth,
                mapHeight: RenderingArcModePixelHeight,
            };
            const startupStatus: AircraftStatus = {
                adiruDataValid: true,
                latitude: 47.26081085205078,
                longitude: 11.349658966064453,
                altitude: 1904,
                heading: 260,
                verticalSpeed: 0,
                gearIsDown: true,
                destinationDataValid: false,
                destinationLatitude: 0.0,
                destinationLongitude: 0.0,
                navigationDisplayCapt: startupConfig,
                navigationDisplayFO: startupConfig,
                navigationDisplayRenderingMode: TerrainRenderingMode.ArcMode,
            };
            const startupPosition: PositionData = {
                latitude: 47.26081085205078,
                longitude: 11.349658966064453,
            };

            // run all process steps to precompile the kernels
            this.onAircraftStatusUpdate(startupStatus, true);
            this.updateGroundTruthPositionAndCachedTiles(startupPosition, true);
            this.renderNavigationDisplay('L', true);

            // reset all initialization data
            this.worldMapMetadata = {
                southwest: { latitude: -100, longitude: -190 },
                northeast: { latitude: -100, longitude: -190 },
                currentGridPosition: { x: 0, y: 0 },
                minWidthPerTile: 0,
                minHeightPerTile: 0,
                width: 0,
                height: 0,
            };
            this.currentGroundTruthPosition = null;
            this.aircraftStatus = null;
            this.cleanupMemory();
            this.initialized = true;

            this.logging.info('Initialized the map handler');
        });
    }

    public shutdown(): void {
        this.initialized = false;

        if (this.simconnect !== null) this.simconnect.terminate();

        // destroy all aircraft specific rendering
        for (const side in this.navigationDisplayRendering) {
            if (side in this.navigationDisplayRendering) {
                if (this.navigationDisplayRendering[side].timeout !== null) clearTimeout(this.navigationDisplayRendering[side].timeout);
                this.navigationDisplayRendering[side].finalMap.destroy();
            }
        }

        // destroy all generic GPU related instances
        if (this.patternMap !== null) this.patternMap.delete();
        if (this.cachedElevationData.gpuData !== null) this.cachedElevationData.gpuData.delete();
        if (this.extractLocalElevationMap !== null) this.extractLocalElevationMap.destroy();
        if (this.uploadWorldMapToGPU !== null) this.uploadWorldMapToGPU.destroy();
        if (this.localElevationHistogram !== null) this.localElevationHistogram.destroy();
        if (this.elevationHistogram !== null) this.elevationHistogram.destroy();
        if (this.uploadPatternMapToGPU !== null) this.uploadPatternMapToGPU.destroy();

        // destroy the context iteslf
        if (this.gpu !== null) this.gpu.destroy();
    }

    private updateGroundTruthPositionAndCachedTiles(position: PositionData, startup: boolean): void {
        if (!this.initialized && !startup) return;
        this.currentGroundTruthPosition = position;
        const grid = this.worldmap.createGridLookupTable(position);
        const loadedTiles = this.worldmap.updatePosition(grid);
        const relevantTileCount = grid.length * grid[0].length;

        if (loadedTiles || this.cachedElevationData.cachedTiles !== relevantTileCount) {
            const [southwestLat, southwestLong] = projectWgs84(position.latitude, position.longitude, 225, this.worldmap.VisibilityRange * 1852);
            const southwestGrid = this.worldmap.worldMapIndices(southwestLat, southwestLong);
            const [northeastLat, northeastLong] = projectWgs84(position.latitude, position.longitude, 45, this.worldmap.VisibilityRange * 1852);
            const northeastGrid = this.worldmap.worldMapIndices(northeastLat, northeastLong);

            this.worldMapMetadata.minWidthPerTile = 5000;
            this.worldMapMetadata.minHeightPerTile = 5000;
            grid.forEach((row) => {
                row.forEach((cellIdx) => {
                    const cell = this.worldmap.TileManager.grid[cellIdx.row][cellIdx.column];
                    if (cell.tileIndex !== -1 && cell.elevationmap && cell.elevationmap.Rows !== 0 && cell.elevationmap.Columns !== 0) {
                        this.worldMapMetadata.minWidthPerTile = Math.min(cell.elevationmap.Columns, this.worldMapMetadata.minWidthPerTile);
                        this.worldMapMetadata.minHeightPerTile = Math.min(cell.elevationmap.Rows, this.worldMapMetadata.minHeightPerTile);
                    }
                });
            });

            if (this.worldMapMetadata.minWidthPerTile === 5000) this.worldMapMetadata.minWidthPerTile = DefaultTileSize;
            if (this.worldMapMetadata.minHeightPerTile === 5000) this.worldMapMetadata.minHeightPerTile = DefaultTileSize;

            const worldWidth = this.worldMapMetadata.minWidthPerTile * grid[0].length;
            const worldHeight = this.worldMapMetadata.minHeightPerTile * grid.length;
            this.cachedElevationData.cpuData = new Float32Array(worldWidth * worldHeight);
            let yOffset = 0;

            grid.forEach((row) => {
                for (let y = 0; y < this.worldMapMetadata.minHeightPerTile; y++) {
                    let xOffset = 0;

                    for (let x = 0; x < row.length; ++x) {
                        const cellIdx = row[x];
                        const cell = this.worldmap.TileManager.grid[cellIdx.row][cellIdx.column];
                        for (let x = 0; x < this.worldMapMetadata.minWidthPerTile; x++) {
                            const index = (y + yOffset) * worldWidth + xOffset + x;

                            if (cell.tileIndex === -1) {
                                this.cachedElevationData.cpuData[index] = WaterElevation;
                            } else if (cell.elevationmap.ElevationMap === undefined) {
                                this.cachedElevationData.cpuData[index] = UnknownElevation;
                            } else {
                                this.cachedElevationData.cpuData[index] = cell.elevationmap.ElevationMap[y * cell.elevationmap.Columns + x];
                            }
                        }

                        xOffset += this.worldMapMetadata.minWidthPerTile;
                    }
                }

                yOffset += this.worldMapMetadata.minHeightPerTile;
            });

            // update the world map metadata for the rendering
            this.worldMapMetadata.southwest.latitude = this.worldmap.TileManager.grid[southwestGrid.row][southwestGrid.column].southwest.latitude;
            this.worldMapMetadata.southwest.longitude = this.worldmap.TileManager.grid[southwestGrid.row][southwestGrid.column].southwest.longitude;
            this.worldMapMetadata.northeast.latitude = this.worldmap.TileManager.grid[northeastGrid.row][northeastGrid.column].southwest.latitude + this.worldmap.GridData.latitudeStep;
            this.worldMapMetadata.northeast.longitude = this.worldmap.TileManager.grid[northeastGrid.row][northeastGrid.column].southwest.longitude + this.worldmap.GridData.longitudeStep;
            this.worldMapMetadata.width = worldWidth;
            this.worldMapMetadata.height = worldHeight;

            this.uploadWorldMapToGPU = this.uploadWorldMapToGPU.setOutput([worldWidth, worldHeight]);
            this.cachedElevationData.gpuData = this.uploadWorldMapToGPU(this.cachedElevationData.cpuData, worldWidth) as Texture;
            // some GPU drivers require the flush call to release internal memory
            if (GpuProcessingActive) this.uploadWorldMapToGPU.context.flush();

            this.worldmap.TileManager.cleanupElevationCache(grid);
            this.cachedElevationData.cachedTiles = relevantTileCount;
        }

        // calculate the correct pixel coordinate in every step
        const southwest = this.worldmap.getSouthwestCoordinateOfTile(this.currentGroundTruthPosition.latitude, this.currentGroundTruthPosition.longitude);
        if (southwest !== undefined) {
            const latStep = this.worldmap.GridData.latitudeStep / this.worldMapMetadata.minHeightPerTile;
            const longStep = this.worldmap.GridData.longitudeStep / this.worldMapMetadata.minWidthPerTile;
            const latDelta = this.currentGroundTruthPosition.latitude - southwest.latitude;
            const longDelta = this.currentGroundTruthPosition.longitude - southwest.longitude;

            let yOffset = 0;
            let xOffset = 0;
            const egoIndex = this.worldmap.worldMapIndices(
                this.currentGroundTruthPosition.latitude,
                this.currentGroundTruthPosition.longitude,
            );
            grid.forEach((row, rowIdx) => {
                if (row[0].row === egoIndex.row) {
                    row.forEach((cell, columnIdx) => {
                        if (cell.column === egoIndex.column) {
                            yOffset = rowIdx * this.worldMapMetadata.minHeightPerTile;
                            xOffset = columnIdx * this.worldMapMetadata.minWidthPerTile;
                        }
                    });
                }
            });

            const globalEgoOffset: { x: number, y: number } = { x: xOffset + longDelta / longStep, y: yOffset + this.worldMapMetadata.minHeightPerTile - latDelta / latStep };
            this.worldMapMetadata.currentGridPosition = globalEgoOffset;
        } else {
            this.worldMapMetadata.currentGridPosition = { x: this.worldMapMetadata.width / 2, y: this.worldMapMetadata.height / 2 };
        }
    }

    private extractElevation(latitude: number, longitude: number): number {
        if (this.cachedElevationData.cpuData === null || this.cachedElevationData.cpuData.length === 0) {
            return InvalidElevation;
        }

        // calculate the pixel movement out of the current position
        const latStep = this.worldmap.GridData.latitudeStep / this.worldMapMetadata.minHeightPerTile;
        const longStep = this.worldmap.GridData.longitudeStep / this.worldMapMetadata.minWidthPerTile;
        const latPixelDelta = (this.aircraftStatus.latitude - latitude) / latStep;
        const longPixelDelta = (longitude - this.aircraftStatus.longitude) / longStep;

        // calculate the map index
        let index = (this.worldMapMetadata.currentGridPosition.y + latPixelDelta) * this.worldMapMetadata.width;
        index += this.worldMapMetadata.currentGridPosition.x + longPixelDelta;
        index = Math.floor(index);

        if (index >= this.cachedElevationData.cpuData.length) return UnknownElevation;

        return this.cachedElevationData.cpuData[index];
    }

    private configureNavigationDisplay(display: string, config: NavigationDisplay, startup: boolean): void {
        if (display in this.navigationDisplayRendering) {
            const lastConfig = this.navigationDisplayRendering[display].config;
            const stopRendering = !config.active && lastConfig !== null && lastConfig.active;
            let startRendering = config.active && (lastConfig === null || !lastConfig.active);
            startRendering ||= lastConfig !== null && ((lastConfig.range !== config.range) || (lastConfig.arcMode !== config.arcMode));
            startRendering ||= lastConfig !== null && (lastConfig.efisMode !== config.efisMode);

            this.navigationDisplayRendering[display].config = config;

            if (!startup) {
                if (stopRendering || startRendering) {
                    if (this.navigationDisplayRendering[display].durationInterval !== null) {
                        clearInterval(this.navigationDisplayRendering[display].durationInterval);
                        this.navigationDisplayRendering[display].durationInterval = null;
                    }
                    if (this.navigationDisplayRendering[display].timeout !== null) {
                        clearTimeout(this.navigationDisplayRendering[display].timeout);
                        this.navigationDisplayRendering[display].timeout = null;
                    }

                    this.navigationDisplayRendering[display].resetRenderingData = true;
                    this.resetFrameData(display);

                    // reset also the aircraft data
                    this.simconnect.sendNavigationDisplayTerrainMapMetadata(display, {
                        MinimumElevation: -1,
                        MinimumElevationMode: TerrainLevelMode.PeaksMode,
                        MaximumElevation: -1,
                        MaximumElevationMode: TerrainLevelMode.PeaksMode,
                        FirstFrame: true,
                        DisplayRange: 0,
                        DisplayMode: 0,
                        FrameByteCount: 0,
                    });
                }

                if (startRendering) {
                    this.startNavigationDisplayRenderingCycle(display);
                }
            }
        }
    }

    private createLocalElevationMap(config: NavigationDisplay): Texture {
        if (this.cachedElevationData.gpuData === null) return null;

        let metresPerPixel = Math.round((config.range * NauticalMilesToMetres) / config.mapHeight);
        if (config.arcMode) metresPerPixel *= 2.0;

        // create the local elevation map
        const localElevationMap = this.extractLocalElevationMap(
            this.aircraftStatus.latitude,
            this.aircraftStatus.longitude,
            this.aircraftStatus.heading,
            this.currentGroundTruthPosition.latitude,
            this.currentGroundTruthPosition.longitude,
            this.worldMapMetadata.currentGridPosition.x,
            this.worldMapMetadata.currentGridPosition.y,
            this.cachedElevationData.gpuData,
            this.worldMapMetadata.width,
            this.worldMapMetadata.height,
            this.worldMapMetadata.southwest.latitude,
            this.worldMapMetadata.southwest.longitude,
            this.worldMapMetadata.northeast.latitude,
            this.worldMapMetadata.northeast.longitude,
            config.mapWidth,
            config.mapHeight,
            metresPerPixel,
            config.arcMode,
        ) as Texture;

        // some GPU drivers require the flush call to release internal memory
        if (GpuProcessingActive) this.extractLocalElevationMap.context.flush();

        return localElevationMap;
    }

    private createElevationHistogram(localElevationMap: Texture, config: NavigationDisplay): Texture {
        if (localElevationMap === null) return null;

        // create the histogram statistics
        const patchesInX = Math.ceil(config.mapWidth / HistogramPatchSize);
        const patchesInY = Math.ceil(config.mapHeight / HistogramPatchSize);
        const patchCount = patchesInX * patchesInY;

        if (this.localElevationHistogram.output === null
            || this.localElevationHistogram.output[1] !== patchCount
        ) {
            this.localElevationHistogram = this.localElevationHistogram
                .setOutput([HistogramBinCount, patchCount]);
        }

        const localHistograms = this.localElevationHistogram(
            localElevationMap,
            config.mapWidth,
            config.mapHeight,
        ) as Texture;
        const histogram = this.elevationHistogram(
            localHistograms,
            patchCount,
        ) as Texture;

        // some GPU drivers require the flush call to release internal memory
        if (GpuProcessingActive) {
            this.localElevationHistogram.context.flush();
            this.elevationHistogram.context.flush();
        }

        return histogram;
    }

    private calculateAbsoluteCutOffAltitude(): number {
        if (this.aircraftStatus === null || this.aircraftStatus.destinationDataValid === false) {
            return HistogramMinimumElevation;
        }

        const destinationElevation = this.extractElevation(this.aircraftStatus.destinationLatitude, this.aircraftStatus.destinationLongitude);

        if (destinationElevation !== InvalidElevation) {
            let cutOffAltitude = RenderingCutOffAltitudeMaximum;

            const distance = distanceWgs84(
                this.aircraftStatus.latitude,
                this.aircraftStatus.longitude,
                this.aircraftStatus.destinationLatitude,
                this.aircraftStatus.destinationLongitude,
            );
            if (distance <= RenderingMaxAirportDistance) {
                const distanceFeet = distance * FeetPerNauticalMile;

                // calculate the glide until touchdown
                const opposite = this.aircraftStatus.altitude - destinationElevation;
                let glideRadian = 0.0;
                if (opposite > 0 && distance > 0) {
                    // calculate the glide slope, opposite [ft] -> distance needs to be converted to feet
                    glideRadian = Math.atan(opposite / distanceFeet);
                }

                // check if the glide is greater or equal 3°
                if (glideRadian < 0.0523599) {
                    if (distance <= 1.0 || glideRadian === 0.0) {
                        // use the minimum value close to the airport
                        cutOffAltitude = RenderingCutOffAltitudeMinimimum;
                    } else {
                        // use a linear model from max to min for 4 nm to 1 nm
                        const slope = (RenderingCutOffAltitudeMinimimum - RenderingCutOffAltitudeMaximum) / ThreeNauticalMilesInFeet;
                        cutOffAltitude = Math.round(slope * (distanceFeet - FeetPerNauticalMile) + RenderingCutOffAltitudeMaximum);

                        // ensure that we are not below the minimum and not above the maximum
                        cutOffAltitude = Math.max(cutOffAltitude, RenderingCutOffAltitudeMinimimum);
                        cutOffAltitude = Math.min(cutOffAltitude, RenderingCutOffAltitudeMaximum);
                    }
                }
            }

            return cutOffAltitude;
        }

        return HistogramMinimumElevation;
    }

    private analyzeMetadata(metadata: number[], cutOffAltitude: number): NavigationDisplayData {
        const retval = new NavigationDisplayData();

        if (metadata[0] === 0) {
            // normal mode
            const [
                _,
                __,
                maxElevation,
                highDensityRed,
                ___,
                lowDensityYellow,
                highDensityGreen,
                lowDensityGreen,
            ] = metadata;

            retval.MinimumElevation = cutOffAltitude > lowDensityGreen ? cutOffAltitude : lowDensityGreen;
            if (lowDensityYellow <= highDensityGreen) {
                retval.MinimumElevationMode = TerrainLevelMode.Warning;
            } else {
                retval.MinimumElevationMode = TerrainLevelMode.PeaksMode;
            }

            retval.MaximumElevation = maxElevation;
            if (maxElevation >= highDensityRed) {
                retval.MaximumElevationMode = TerrainLevelMode.Caution;
            } else {
                retval.MaximumElevationMode = TerrainLevelMode.Warning;
            }
        } else {
            // peaks mode
            const [
                _,
                minElevation,
                maxElevation,
                __,
                ___,
                lowDensityGreen,
            ] = metadata;

            if (maxElevation < 0) {
                retval.MinimumElevation = -1;
                retval.MaximumElevation = 0;
            } else {
                retval.MinimumElevation = lowDensityGreen > minElevation ? lowDensityGreen : minElevation;
                retval.MaximumElevation = maxElevation;
            }
            retval.MinimumElevationMode = TerrainLevelMode.PeaksMode;
            retval.MaximumElevationMode = TerrainLevelMode.PeaksMode;
        }

        return retval;
    }

    /*
     * Concept for the metadata row:
     * - The idea comes initialy from image capturing systems and image decoding information, etc are stored in dedicated rows of one image
     * - The ND rendering reuses this idea to store the relevant information in two pixels
     *   Take a deeper look in the GPU code to get the channel and pixel encoding
     * - The statistics calculation is done on the GPU to reduce the number of transmitted data from the GPU to the CPU
     *   The reduction increases the system performance and an additional row is less time consuming than transmitting the histogram
     * - The red channel of the first pixel in the last row defines the rendering mode (0 === normal mode, 1 === peaks mode)
     */
    private createNavigationDisplayMap(
        side: string,
        config: NavigationDisplay,
        elevationMap: Texture,
        histogram: Texture,
        cutOffAltitude: number,
    ): KernelOutput {
        if (elevationMap === null || histogram === null) return null;

        const terrainmap = this.navigationDisplayRendering[side].finalMap(
            elevationMap,
            histogram,
            this.patternMap,
            config.mapWidth,
            config.mapHeight,
            config.mapOffsetX,
            this.aircraftStatus.altitude,
            this.aircraftStatus.verticalSpeed,
            this.aircraftStatus.gearIsDown ? RenderingGearDownOffset : RenderingNonGearDownOffset,
            cutOffAltitude,
        ) as KernelOutput;

        // some GPU drivers require the flush call to release internal memory
        if (GpuProcessingActive) this.navigationDisplayRendering[side].finalMap.context.flush();

        return terrainmap;
    }

    private arcModeTransitionFrame(
        config: NavigationDisplay,
        oldFrame: Uint8ClampedArray,
        newFrame: Uint8ClampedArray,
        startAngle: number,
        endAngle: number,
    ): Uint8ClampedArray {
        const result = new Uint8ClampedArray(RenderingMaxPixelWidth * RenderingColorChannelCount * RenderingScreenPixelHeight);

        // access data as uint32-array for performance reasons
        const destination = new Uint32Array(result.buffer);
        // UInt32-version of RGBA (4, 4, 5, 255)
        destination.fill(4278518788);
        const oldSource = oldFrame !== null ? new Uint32Array(oldFrame.buffer) : null;
        const newSource = new Uint32Array(newFrame.buffer);

        let arrayIndex = RenderingMapStartOffsetY * RenderingMaxPixelWidth;
        for (let y = 0; y < config.mapHeight; ++y) {
            for (let x = 0; x < RenderingMaxPixelWidth; ++x) {
                if (x >= config.mapOffsetX && x < (config.mapOffsetX + config.mapWidth)) {
                    const distance = Math.sqrt((x - RenderingMaxPixelWidth / 2) ** 2 + (config.mapHeight - y) ** 2);
                    const angle = Math.acos((config.mapHeight - y) / distance) * (180.0 / Math.PI);

                    if (startAngle <= angle && angle <= endAngle) {
                        destination[arrayIndex] = newSource[arrayIndex];
                    } else if (oldSource !== null) {
                        destination[arrayIndex] = oldSource[arrayIndex];
                    }
                }

                arrayIndex++;
            }
        }

        return result;
    }

    private arcModeTransition(side: string, config: NavigationDisplay, frameData: Uint8ClampedArray, thresholdData: NavigationDisplayData): void {
        const transitionFrames: Uint8ClampedArray[] = [];

        if (this.navigationDisplayRendering[side].resetRenderingData) {
            this.navigationDisplayRendering[side].resetRenderingData = false;
            this.resetFrameData(side);
        }
        if (this.navigationDisplayRendering[side].durationInterval !== null) {
            clearInterval(this.navigationDisplayRendering[side].durationInterval);
            this.navigationDisplayRendering[side].durationInterval = null;
        }

        thresholdData.DisplayRange = config.range;
        thresholdData.DisplayMode = config.efisMode;

        let startAngle = 0;
        if (this.navigationDisplayRendering[side].lastFrame === null) {
            const timeSinceStart = new Date().getTime() - this.navigationDisplayRendering[side].startupTimestamp;
            const frameUpdateCount = timeSinceStart / RenderingMapFrameValidityTime;
            const ratioSinceLastFrame = frameUpdateCount - Math.floor(frameUpdateCount);
            startAngle = Math.floor(90 * ratioSinceLastFrame);
        }

        let angle = 0;
        let firstFrame = true;
        let lastFrame = null;
        this.navigationDisplayRendering[side].durationInterval = setInterval(() => {
            angle += RenderingMapTransitionAngularStep;
            let stopInterval = false;
            let frame = null;

            if (angle < 90) {
                frame = this.arcModeTransitionFrame(config, this.navigationDisplayRendering[side].lastFrame, frameData, startAngle, angle);
            } else {
                stopInterval = true;
                if (angle - RenderingMapTransitionAngularStep < 90) {
                    frame = this.arcModeTransitionFrame(config, this.navigationDisplayRendering[side].lastFrame, frameData, startAngle, 90);
                    lastFrame = frame;
                }

                // do not overwrite the last frame of the initialization
                if (startAngle === 0) {
                    this.navigationDisplayRendering[side].lastFrame = frameData;
                    frame = frameData;
                } else {
                    this.navigationDisplayRendering[side].lastFrame = lastFrame;
                }
            }

            // transfer the transition frame
            if (frame !== null) {
                sharp(frame, { raw: { width: RenderingMaxPixelWidth, height: RenderingScreenPixelHeight, channels: RenderingColorChannelCount } })
                    .png()
                    .toBuffer()
                    .then((buffer) => {
                        thresholdData.FrameByteCount = buffer.byteLength;
                        thresholdData.FirstFrame = firstFrame;

                        this.simconnect.sendNavigationDisplayTerrainMapMetadata(side, thresholdData);
                        this.simconnect.sendNavigationDisplayTerrainMapFrame(side, buffer);

                        // store the data for the web UI
                        transitionFrames.push(new Uint8ClampedArray(buffer));
                        firstFrame = false;
                    });
            }

            if (stopInterval && !this.navigationDisplayRendering[side].resetRenderingData) {
                clearInterval(this.navigationDisplayRendering[side].durationInterval);
                this.navigationDisplayRendering[side].durationInterval = null;

                this.navigationDisplayRendering[side].lastTransitionData.timestamp = new Date().getTime();
                this.navigationDisplayRendering[side].lastTransitionData.frames = transitionFrames;
                this.navigationDisplayRendering[side].lastTransitionData.thresholds = {
                    minElevation: thresholdData.MinimumElevation,
                    minElevationIsWarning: thresholdData.MinimumElevationMode === TerrainLevelMode.Warning,
                    minElevationIsCaution: thresholdData.MinimumElevationMode === TerrainLevelMode.Caution,
                    maxElevation: thresholdData.MaximumElevation,
                    maxElevationIsWarning: thresholdData.MaximumElevationMode === TerrainLevelMode.Warning,
                    maxElevationIsCaution: thresholdData.MaximumElevationMode === TerrainLevelMode.Warning,
                };

                if (this.navigationDisplayRendering[side].timeout !== null) {
                    clearTimeout(this.navigationDisplayRendering[side].timeout);
                    this.navigationDisplayRendering[side].timeout = null;
                }
                if (this.navigationDisplayRendering[side].config.active) {
                    this.navigationDisplayRendering[side].timeout = setTimeout(() => this.renderNavigationDisplay(side), RenderingMapUpdateTimeout);
                }
            }

            lastFrame = frame;
        }, RenderingMapTransitionDeltaTime);
    }

    private createScreenResolutionFrame(config: NavigationDisplay, gpuData: Uint8ClampedArray): Uint8ClampedArray {
        const result = new Uint8ClampedArray(RenderingMaxPixelWidth * RenderingColorChannelCount * RenderingScreenPixelHeight);

        // access data as uint32-array for performance reasons
        const destination = new Uint32Array(result.buffer);
        // UInt32-version of RGBA (4, 4, 5, 255)
        destination.fill(4278518788);
        const source = new Uint32Array(gpuData.buffer);

        // manual iteration is 2x faster compared to splice
        let sourceIndex = 0;
        let destinationIndex = RenderingMapStartOffsetY * RenderingMaxPixelWidth;
        for (let y = 0; y < config.mapHeight; ++y) {
            for (let x = 0; x < RenderingMaxPixelWidth; ++x) {
                destination[destinationIndex] = source[sourceIndex];
                destinationIndex++;
                sourceIndex++;
            }
        }

        return result;
    }

    private renderNavigationDisplay(side: string, startup: boolean = false): void {
        if (this.navigationDisplayRendering[side].timeout !== null) {
            clearTimeout(this.navigationDisplayRendering[side].timeout);
            this.navigationDisplayRendering[side].timeout = null;
        }
        if (this.navigationDisplayRendering[side].durationInterval !== null) {
            clearInterval(this.navigationDisplayRendering[side].durationInterval);
            this.navigationDisplayRendering[side].durationInterval = null;
        }

        // no valid position data received
        if (this.currentGroundTruthPosition === undefined) {
            this.logging.warn('No valid position received for rendering');
        } else if (this.navigationDisplayRendering[side].config === undefined) {
            this.logging.warn('No navigation display configuration received');
        } else {
            const { config } = this.navigationDisplayRendering[side];
            config.mapWidth = config.arcMode ? RenderingArcModePixelWidth : RenderingRoseModePixelWidth;
            config.mapHeight = config.arcMode ? RenderingArcModePixelHeight : RenderingRoseModePixelHeight;
            config.mapOffsetX = Math.round((RenderingMaxPixelWidth - config.mapWidth) * 0.5);

            const elevationMap = this.createLocalElevationMap(config);
            const histogram = this.createElevationHistogram(elevationMap, config);

            const cutOffAltitude = this.calculateAbsoluteCutOffAltitude();

            // create the final map
            const renderingData = this.createNavigationDisplayMap(side, config, elevationMap, histogram, cutOffAltitude);
            if (renderingData === null) return;

            const frame = renderingData as number[][];
            const metadata = frame.splice(frame.length - 1)[0];
            const imageData = new Uint8ClampedArray(fastFlatten(frame));

            // send the threshold data for the map
            const thresholdData = this.analyzeMetadata(metadata, cutOffAltitude);

            if (!startup) {
                switch (this.aircraftStatus.navigationDisplayRenderingMode) {
                case TerrainRenderingMode.ArcMode:
                    this.arcModeTransition(side, config, this.createScreenResolutionFrame(config, imageData), thresholdData);
                    break;
                default:
                    this.logging.error('Failed to determine a terrain rendering mode', `Unknown rendering mode defined: ${this.aircraftStatus.navigationDisplayRenderingMode}`);
                    break;
                }
            }
        }
    }

    public startNavigationDisplayRenderingCycle(side: string): void {
        if (this.navigationDisplayRendering[side].timeout !== null) {
            clearTimeout(this.navigationDisplayRendering[side].timeout);
            this.navigationDisplayRendering[side].timeout = null;
        }

        if (side in this.navigationDisplayRendering) {
            this.renderNavigationDisplay(side);
        }
    }

    public stopRendering(): void {
        if (this.navigationDisplayRendering.L.config !== null) {
            this.navigationDisplayRendering.L.config.active = false;
        }
        if (this.navigationDisplayRendering.L.durationInterval !== null) {
            clearInterval(this.navigationDisplayRendering.L.durationInterval);
            this.navigationDisplayRendering.L.durationInterval = null;
        }
        if (this.navigationDisplayRendering.L.timeout !== null) {
            clearTimeout(this.navigationDisplayRendering.L.timeout);
            this.navigationDisplayRendering.L.timeout = null;
        }
        this.navigationDisplayRendering.L.lastFrame = null;

        if (this.navigationDisplayRendering.R.config !== null) {
            this.navigationDisplayRendering.R.config.active = false;
        }
        if (this.navigationDisplayRendering.R.durationInterval !== null) {
            clearInterval(this.navigationDisplayRendering.R.durationInterval);
            this.navigationDisplayRendering.R.durationInterval = null;
        }
        if (this.navigationDisplayRendering.R.timeout !== null) {
            clearTimeout(this.navigationDisplayRendering.R.timeout);
            this.navigationDisplayRendering.R.timeout = null;
        }
        this.navigationDisplayRendering.R.lastFrame = null;
    }

    public frameData(side: string): { side: string, timestamp: number, thresholds: NavigationDisplayThresholdsDto, frames: Uint8ClampedArray[] } {
        if (side in this.navigationDisplayRendering) {
            return {
                side,
                timestamp: this.navigationDisplayRendering[side].lastTransitionData.timestamp,
                thresholds: this.navigationDisplayRendering[side].lastTransitionData.thresholds,
                frames: this.navigationDisplayRendering[side].lastTransitionData.frames,
            };
        }

        return { side, timestamp: 0, thresholds: null, frames: [] };
    }
}

const maphandler = new MapHandler(new ThreadLogger());

parentPort.on('message', (data: { request: string, content: string }) => {
    if (data.request === 'REQ_FRAME_DATA') {
        parentPort.postMessage({ request: 'RES_FRAME_DATA', content: maphandler.frameData(data.content) });
    } else if (data.request === 'REQ_SHUTDOWN') {
        maphandler.shutdown();
    }
});
