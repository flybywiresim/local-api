import { parentPort } from 'worker_threads';
import { GPU, IKernelRunShortcut, KernelOutput, Texture } from 'gpu.js';
import { RenderingData, TileData } from '../manager/worldmap';
import { TerrainMap } from '../mapformat/terrainmap';
import { createLocalElevationMap, extractElevation } from './gpu/elevationmap';
import { registerHelperFunctions } from './gpu/helper';
import { HistogramConstants, LocalElevationMapConstants, NavigationDisplayConstants } from './gpu/interfaces';
import { registerNavigationDisplayFunctions, renderNavigationDisplay } from './gpu/navigationdisplay';
import { createElevationHistogram, createLocalElevationHistogram } from './gpu/statistics';
import { TileManager } from '../manager/tilemanager';
import { calculateAbsoluteCutOffAltitude } from './generic/statistics';

const sharp = require('sharp');

// debug configuration
const DebugElevationMap = true;
const DebugHistogram = false;
const DebugRendering = true;

// elevation map constants
const InvalidDataValue = -1;
const InvalidElevation = 32767;
const UnknownElevation = 32766;
const WaterElevation = -1;
const FlattenGridRowIndex = 0;
const FlattenGridColumnIndex = 1;
const FlattenGridTileIndex = 2;
const FlattenGridRowCount = 3;
const FlattenGridColumnCount = 4;
const FlattenGridEntryCount = 5;
const FlattenTileIndex = 0;
const FlattenTileOffset = 1;
const FlattenTileEntryCount = 2;

// histogram parameters
const HistogramBinRange = 100;
const HistogramMinimumElevation = -500; // some areas in the world are below water level
const HistogramMaximumElevation = 29040; // mount everest
const HistogramBinCount = Math.ceil((HistogramMaximumElevation - HistogramMinimumElevation + 1) / HistogramBinRange);
const HistogramPatchSize = 128;

// rendering parameters
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

function uploadTexture(texture: number[]): number {
    return texture[this.thread.x];
}

class NavigationDisplayRenderer {
    private flattenedGridData: { grid: number[], tileCount: number } = null;

    private flattenedTileData: {
        indices: number[],
        tiles: number[][],
        offsets: number[],
        buffer: number[],
        bufferLength: number,
    } = null;

    private gpuInstance: GPU = null;

    private uploadWorldGridToGPU: IKernelRunShortcut = null;

    private uploadTileBufferToGPU: IKernelRunShortcut = null;

    private localElevationMap: IKernelRunShortcut = null;

    private localElevationHistogram: IKernelRunShortcut = null;

    private elevationHistogram: IKernelRunShortcut = null;

    private navigationDisplayRendering: IKernelRunShortcut = null;

    private gpuWorldGridBuffer: Texture = null;

    private gpuTileBuffer: Texture = null;

    private static fastFlatten<T>(arr: T[][]): T[] {
        const numElementsUptoIndex = Array(arr.length);
        numElementsUptoIndex[0] = 0;
        for (let i = 1; i < arr.length; i++) {
            numElementsUptoIndex[i] = numElementsUptoIndex[i - 1] + arr[i - 1].length;
        }
        const flattened = new Array(numElementsUptoIndex[arr.length - 1] + arr[arr.length - 1].length);
        let skip;
        for (let i = 0; i < arr.length; i++) {
            skip = numElementsUptoIndex[i];
            for (let j = 0; j < arr[i].length; j++) {
                flattened[skip + j] = arr[i][j];
            }
        }
        return flattened;
    }

    public async initialize(terrainmap: TerrainMap): Promise<void> {
        this.flattenedGridData = {
            grid: [],
            tileCount: 0,
        };
        this.flattenedTileData = {
            indices: [],
            tiles: [],
            offsets: [],
            buffer: [],
            bufferLength: 0,
        };

        const tileManager = new TileManager(terrainmap);
        tileManager.grid.forEach((row, rowIndex) => {
            row.forEach((tile, columnIndex) => {
                if (tile.tileIndex !== -1) {
                    this.flattenedGridData.grid.push(rowIndex);
                    this.flattenedGridData.grid.push(columnIndex);
                    this.flattenedGridData.grid.push(tile.tileIndex);
                    this.flattenedGridData.grid.push(InvalidDataValue);
                    this.flattenedGridData.grid.push(InvalidDataValue);
                }
            });
        });

        this.flattenedGridData.tileCount = this.flattenedGridData.grid.length / FlattenGridEntryCount;

        // prepare the GPU environment
        this.gpuInstance = new GPU({ mode: 'gpu' });
        registerHelperFunctions(this.gpuInstance);
        registerNavigationDisplayFunctions(this.gpuInstance);

        this.uploadWorldGridToGPU = this.gpuInstance
            .createKernel(uploadTexture, {
                argumentTypes: { texture: 'Array' },
                dynamicArguments: true,
                pipeline: true,
                precision: 'single',
                strictIntegers: true,
                tactic: 'speed',
            })
            .setOutput([this.flattenedGridData.grid.length]);

        this.uploadTileBufferToGPU = this.gpuInstance
            .createKernel(uploadTexture, {
                argumentTypes: { texture: 'Array' },
                dynamicArguments: true,
                dynamicOutput: true,
                pipeline: true,
                precision: 'single',
                strictIntegers: true,
                tactic: 'speed',
            });

        this.localElevationMap = this.gpuInstance
            .createKernel(createLocalElevationMap, {
                dynamicArguments: true,
                dynamicOutput: true,
                pipeline: true,
                precision: 'single',
                strictIntegers: true,
                tactic: 'speed',
            })
            .setConstants<LocalElevationMapConstants>({
                latitudeStepPerTile: 1,
                longitudeStepPerTile: 1,
                worldGridElementCount: this.flattenedGridData.tileCount,
                invalidDataValue: InvalidDataValue,
                invalidElevation: InvalidElevation,
                unknownElevation: UnknownElevation,
                waterElevation: WaterElevation,
                gridRowIndex: FlattenGridRowIndex,
                gridColumnIndex: FlattenGridColumnIndex,
                gridTileIndex: FlattenGridTileIndex,
                gridRowCount: FlattenGridRowCount,
                gridColumnCount: FlattenGridColumnCount,
                gridEntryCount: FlattenGridEntryCount,
                flattenTileIndex: FlattenTileIndex,
                flattenTileOffset: FlattenTileOffset,
                flattenTileEntryCount: FlattenTileEntryCount,
            })
            .setLoopMaxIterations(this.flattenedGridData.tileCount); // number of tiles in the world

        this.localElevationHistogram = this.gpuInstance
            .createKernel(createLocalElevationHistogram, {
                dynamicArguments: true,
                dynamicOutput: true,
                pipeline: true,
                precision: 'single',
                strictIntegers: true,
                tactic: 'speed',
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

        this.elevationHistogram = this.gpuInstance
            .createKernel(createElevationHistogram, {
                dynamicArguments: true,
                pipeline: true,
                precision: 'single',
                strictIntegers: true,
                tactic: 'speed',
            })
            .setLoopMaxIterations(500)
            .setOutput([HistogramBinCount]);

        this.navigationDisplayRendering = this.gpuInstance
            .createKernel(renderNavigationDisplay, {
                dynamicArguments: true,
                dynamicOutput: true,
                pipeline: false,
                immutable: false,
                precision: 'single',
                strictIntegers: true,
                tactic: 'speed',
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
            });
    }

    public shutdown(): void {
        if (this.uploadWorldGridToGPU !== null) this.uploadWorldGridToGPU.destroy();
        if (this.uploadTileBufferToGPU !== null) this.uploadTileBufferToGPU.destroy();
        if (this.localElevationMap !== null) this.localElevationMap.destroy();
        if (this.localElevationHistogram !== null) this.localElevationHistogram.destroy();
        if (this.elevationHistogram !== null) this.elevationHistogram.destroy();
        if (this.navigationDisplayRendering !== null) this.navigationDisplayRendering.destroy();
        if (this.gpuInstance !== null) this.gpuInstance.destroy();
    }

    private findFlattenGridDataOffset(row: number, column: number): number {
        for (let i = 0; i < this.flattenedGridData.tileCount; ++i) {
            const offset = i * FlattenGridEntryCount;
            if (row === this.flattenedGridData.grid[offset + FlattenGridRowIndex] && column === this.flattenedGridData.grid[offset + FlattenGridColumnIndex]) {
                return offset;
            }
        }

        return -1;
    }

    public updateTileData(whitelist: { row: number, column: number }[], loadedTiles: TileData[]): void {
        const tileData = [];
        let tileOffset = 0;

        this.flattenedTileData.bufferLength = 0;

        // cleanup cached data and collect whitelist entries
        for (let i = 0; i < this.flattenedGridData.tileCount; ++i) {
            const offset = i * FlattenGridEntryCount;

            if (this.flattenedGridData.grid[offset + FlattenGridTileIndex] !== -1) {
                const tileIndex = this.flattenedTileData.indices.findIndex((tile) => tile === this.flattenedGridData.grid[offset + FlattenGridTileIndex]);
                const gridIndex = whitelist.findIndex((entry) => (
                    this.flattenedGridData.grid[offset + FlattenGridRowIndex] === entry.row
                        && this.flattenedGridData.grid[offset + FlattenGridColumnIndex] === entry.column
                ));

                if (gridIndex === -1) {
                    // reset internal data
                    this.flattenedGridData.grid[offset + FlattenGridRowCount] = InvalidDataValue;
                    this.flattenedGridData.grid[offset + FlattenGridColumnCount] = InvalidDataValue;

                    // reset the flatten tiles
                    if (tileIndex !== -1) {
                        this.flattenedTileData.indices.splice(tileIndex, 1);
                        this.flattenedTileData.tiles.splice(tileIndex, 1);
                    }
                } else {
                    // skip the ones that are newly added
                    if (tileIndex !== -1) {
                        tileData.push(this.flattenedGridData.grid[offset + FlattenGridTileIndex]);
                        tileData.push(tileOffset);
                        tileOffset += this.flattenedTileData.tiles[tileIndex].length;
                    }

                    // remove found entry
                    whitelist.splice(gridIndex, 1);
                }
            }
        }

        loadedTiles.forEach((tile) => {
            if (tile.grid !== null) {
                const flatGridOffset = this.findFlattenGridDataOffset(tile.row, tile.column);
                if (flatGridOffset < 0) {
                    console.log(`ERROR: Invalid tile received: ${tile.row}, ${tile.column}`);
                }
                if (tile.grid !== undefined && tile.grid.MapLoaded) {
                    this.flattenedGridData.grid[flatGridOffset + FlattenGridRowCount] = tile.grid.Rows;
                    this.flattenedGridData.grid[flatGridOffset + FlattenGridColumnCount] = tile.grid.Columns;
                    const tileIndex = this.flattenedGridData.grid[flatGridOffset + FlattenGridTileIndex];

                    this.flattenedTileData.indices.push(tileIndex);
                    this.flattenedTileData.tiles.push(Array.from(tile.grid.ElevationMap));

                    tileData.push(tileIndex);
                    tileData.push(tileOffset);
                    tileOffset += this.flattenedTileData.tiles[this.flattenedTileData.tiles.length - 1].length;
                } else {
                    this.flattenedGridData.grid[flatGridOffset + FlattenGridRowCount] = InvalidDataValue;
                    this.flattenedGridData.grid[flatGridOffset + FlattenGridColumnCount] = InvalidDataValue;
                }
            }
        });

        // update the GPU data
        this.flattenedTileData.offsets = tileData;

        if (this.uploadWorldGridToGPU !== null && this.uploadTileBufferToGPU !== null) {
            // upload the world grid
            let start = performance.now();
            this.gpuWorldGridBuffer = this.uploadWorldGridToGPU(this.flattenedGridData.grid) as Texture;
            console.log(`World upload: ${performance.now() - start}`);

            // upload the cached tiles
            start = performance.now();
            this.flattenedTileData.buffer = NavigationDisplayRenderer.fastFlatten(this.flattenedTileData.tiles);

            if (this.uploadTileBufferToGPU.output === null || this.flattenedTileData.buffer.length !== this.uploadTileBufferToGPU.output[0]) {
                this.uploadTileBufferToGPU = this.uploadTileBufferToGPU.setOutput([this.flattenedTileData.buffer.length]);
            }

            this.gpuTileBuffer = this.uploadTileBufferToGPU(this.flattenedTileData.buffer) as Texture;
            console.log(`Tile upload: ${performance.now() - start}`);

            this.flattenedTileData.bufferLength = this.flattenedTileData.buffer.length;
        }
    }

    public async render(data: RenderingData): Promise<void> {
        if (this.localElevationMap !== null) {
            let destinationElevation = HistogramMinimumElevation;
            let start = 0;

            if (data.viewConfig.destinationLatitude !== undefined && data.viewConfig.destinationLongitude !== undefined) {
                destinationElevation = extractElevation(
                    {
                        latitudeStepPerTile: 1,
                        longitudeStepPerTile: 1,
                        worldGridElementCount: this.flattenedGridData.tileCount,
                        invalidDataValue: InvalidDataValue,
                        invalidElevation: InvalidElevation,
                        unknownElevation: UnknownElevation,
                        waterElevation: WaterElevation,
                        gridRowIndex: FlattenGridRowIndex,
                        gridColumnIndex: FlattenGridColumnIndex,
                        gridTileIndex: FlattenGridTileIndex,
                        gridRowCount: FlattenGridRowCount,
                        gridColumnCount: FlattenGridColumnCount,
                        gridEntryCount: FlattenGridEntryCount,
                        flattenTileIndex: FlattenTileIndex,
                        flattenTileOffset: FlattenTileOffset,
                        flattenTileEntryCount: FlattenTileEntryCount,
                    },
                    data.viewConfig.destinationLatitude,
                    data.viewConfig.destinationLongitude,
                    this.flattenedGridData.grid,
                    this.flattenedTileData.indices.length,
                    this.flattenedTileData.offsets,
                    this.flattenedTileData.buffer,
                    this.flattenedTileData.bufferLength,
                );
            }

            if (this.localElevationMap.output === null
                || data.viewConfig.mapWidth !== this.localElevationMap.output[0]
                || data.viewConfig.mapHeight !== this.localElevationMap.output[1]
            ) {
                this.localElevationMap = this.localElevationMap
                    .setOutput([data.viewConfig.mapWidth, data.viewConfig.mapHeight]);
            }

            start = performance.now();
            const elevationGrid = this.localElevationMap(
                data.position.latitude,
                data.position.longitude,
                data.position.heading,
                [data.viewConfig.mapWidth, data.viewConfig.mapHeight],
                data.viewConfig.meterPerPixel,
                this.gpuWorldGridBuffer,
                this.flattenedTileData.indices.length,
                this.flattenedTileData.offsets,
                this.gpuTileBuffer,
                this.flattenedTileData.bufferLength,
            ) as Texture;
            console.log(`Elevation map: ${performance.now() - start}`);

            if (DebugElevationMap) {
                const elevations = NavigationDisplayRenderer.fastFlatten(elevationGrid.toArray() as number[][]);
                let maxElevation = 0;
                let minElevation = 1000;
                elevations.forEach((entry) => {
                    maxElevation = Math.max(entry, maxElevation);
                    minElevation = Math.min(entry, minElevation);
                });

                const image = new Uint8ClampedArray(elevations.length);
                elevations.forEach((entry, index) => {
                    const gray = Math.max(Math.min((entry / maxElevation) * 255, 255), 0);
                    image[index] = gray;
                });

                await sharp(image, { raw: { width: data.viewConfig.mapWidth, height: data.viewConfig.mapHeight, channels: 1 } })
                    .png()
                    .toFile('elevationmap.png');
            }

            const patchesInX = Math.floor(data.viewConfig.mapWidth / HistogramPatchSize);
            const patchesInY = Math.floor(data.viewConfig.mapHeight / HistogramPatchSize);
            const patchCount = patchesInX * patchesInY;
            if (this.localElevationHistogram.output === null
                || this.localElevationHistogram.output[1] !== patchCount
            ) {
                this.localElevationHistogram = this.localElevationHistogram
                    .setOutput([HistogramBinCount, patchCount]);
            }

            start = performance.now();
            const localHistograms = this.localElevationHistogram(
                elevationGrid,
                data.viewConfig.mapWidth,
                data.viewConfig.mapHeight,
            ) as Texture;
            const histogram = this.elevationHistogram(
                localHistograms,
                patchCount,
            ) as Texture;
            console.log(`Histogram: ${performance.now() - start}`);

            if (DebugHistogram) {
                let entryCount = 0;
                (histogram.toArray() as number[]).forEach((entry, index) => {
                    if (entry !== 0) {
                        const lowerElevation = index * HistogramBinRange + HistogramMinimumElevation;
                        const upperElevation = (index + 1) * HistogramBinRange + HistogramMinimumElevation;
                        console.log(`[${lowerElevation}, ${upperElevation}[ = ${entry}`);
                        entryCount += entry;
                    }
                });
                console.log(`${entryCount} of ${data.viewConfig.mapHeight * data.viewConfig.mapWidth} px`);
            }

            /* calculate the statistics */
            start = performance.now();
            const cutOffAltitude = calculateAbsoluteCutOffAltitude(
                data.position.latitude,
                data.position.longitude,
                data.position.altitude,
                data.viewConfig.destinationLatitude,
                data.viewConfig.destinationLongitude,
                destinationElevation,
                RenderingMaxAirportDistance,
                HistogramMinimumElevation,
                data.viewConfig.cutOffAltitudeMinimimum,
                data.viewConfig.cutOffAltitudeMaximum,
                InvalidElevation,
            );
            console.log(`Statistics: ${performance.now() - start}`);

            if (this.navigationDisplayRendering.output === null
                || data.viewConfig.mapWidth * 4 !== this.navigationDisplayRendering.output[0]
                || data.viewConfig.mapHeight !== this.navigationDisplayRendering.output[1]
            ) {
                this.navigationDisplayRendering = this.navigationDisplayRendering
                    .setOutput([data.viewConfig.mapWidth * 4, data.viewConfig.mapHeight]);
            }

            start = performance.now();
            const terrainmap = this.navigationDisplayRendering(
                elevationGrid,
                histogram,
                data.viewConfig.mapWidth,
                data.position.altitude,
                data.position.verticalSpeed,
                data.viewConfig.gearDown ? RenderingGearDownOffset : RenderingNonGearDownOffset,
                cutOffAltitude,
            ) as KernelOutput;
            console.log(`Rendering: ${performance.now() - start}`);

            if (DebugRendering) {
                const image = new Uint8ClampedArray(NavigationDisplayRenderer.fastFlatten(terrainmap as number[][]));
                await sharp(image, { raw: { width: data.viewConfig.mapWidth, height: data.viewConfig.mapHeight, channels: 4 } })
                    .png()
                    .toFile('rendered.png');
            }
        }
    }
}

const renderer = new NavigationDisplayRenderer();

async function createNavigationDisplayMaps(data: RenderingData) {
    // no valid position data received
    if (data.position === undefined) {
        console.log('No valid position received for rendering');
        parentPort.postMessage(undefined);
    } else {
        renderer.render(data);
        parentPort.postMessage(undefined);
    }
}

parentPort.on('message', (data: { type: string, instance: any }) => {
    if (data.type === 'INITIALIZATION') {
        renderer.initialize(data.instance as TerrainMap);
    } else if (data.type === 'TILES') {
        renderer.updateTileData(data.instance.whitelist, data.instance.loadedTiles);
    } else if (data.type === 'RENDERING') {
        createNavigationDisplayMaps(data.instance as RenderingData);
    } else if (data.type === 'SHUTDOWN') {
        renderer.shutdown();
        parentPort.postMessage(undefined);
    }
});