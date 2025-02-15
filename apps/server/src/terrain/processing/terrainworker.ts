import { GPU } from 'gpu.js';
import { parentPort } from 'worker_threads';
import * as sharp from 'sharp';
import {
  AircraftStatus,
  DisplaySide,
  MainToWorkerThreadMessage,
  MainToWorkerThreadMessageTypes,
  EfisData,
  PositionData,
  TerrainLevelMode,
  TerrainRenderingMode,
  VerticalPathData,
  WorkerToMainThreadMessageTypes,
} from '../types';
import { SimConnect } from '../communication/simconnect';
import { NavigationDisplayThresholdsDto } from '../dto/navigationdisplaythresholds.dto';
import {
  GpuProcessingActive,
  NauticalMilesToMetres,
  NavigationDisplayMapStartOffsetY,
  NavigationDisplayMaxPixelHeight,
  NavigationDisplayMaxPixelWidth,
  RenderingColorChannelCount,
  RenderingMapTransitionDeltaTime,
  RenderingMapUpdateTimeoutArcMode,
  RenderingMapUpdateTimeoutScanlineMode,
  VerticalDisplayMapStartOffsetX,
  VerticalDisplayMapStartOffsetY,
} from './generic/constants';
import { Logger } from './logging/logger';
import { ThreadLogger } from './logging/threadlogger';
import { MapHandler } from './maphandler';
import { NavigationDisplayRenderer } from './navigationdisplayrenderer';
import { VerticalDisplayRenderer } from './verticaldisplayrenderer';
import { projectWgs84 } from 'apps/server/src/terrain/processing/gpu/helper';

const DisplayScreenPixelHeightWithoutVerticalDisplay = 768;
const DisplayScreenPixelHeightWithVerticalDisplay = 1024;

class TerrainWorker {
  private initialized: boolean = false;

  private simconnect: SimConnect = null;

  private simPaused: boolean = true;

  private renderingMode: TerrainRenderingMode = TerrainRenderingMode.ArcMode;

  private forceRedraw: boolean = false;

  private manualAzimEnabled: boolean = true;
  private manualAzimDegrees: number = 0;
  private manualAzimEndPoint: [number, number] | null = null;

  private simBridgeClientUsed = false;

  private gpu: GPU = null;

  private mapHandler: MapHandler = null;

  private displayDimension: {
    width: number;
    height: number;
  } = {
    width: 0,
    height: 0,
  };

  private verticalDisplayRequired: boolean = false;

  private displayRendering: {
    [side: string]: {
      timeout: NodeJS.Timeout;
      durationInterval: NodeJS.Timer;
      startupTimestamp: number;
      navigationDisplay: NavigationDisplayRenderer;
      renderedLastFrameNavigationDisplay: boolean;
      verticalDisplay: VerticalDisplayRenderer;
      renderedLastFrameVerticalDisplay: boolean;
      cycleData: {
        timestamp: number;
        thresholds: NavigationDisplayThresholdsDto;
        frames: Uint8ClampedArray[];
      };
    };
  } = {};

  private onReset(): void {
    if (this.initialized === false) return;

    if (this.mapHandler !== null) this.mapHandler.reset();
    if (this.displayRendering.L.navigationDisplay !== null) this.displayRendering.L.navigationDisplay.reset();
    if (this.displayRendering.L.verticalDisplay !== null) this.displayRendering.L.verticalDisplay.reset();
    if (this.displayRendering.R.navigationDisplay !== null) this.displayRendering.R.navigationDisplay.reset();
    if (this.displayRendering.R.verticalDisplay !== null) this.displayRendering.R.verticalDisplay.reset();
  }

  private onPaused(): void {
    this.simPaused = true;
  }

  private onUnpaused(): void {
    this.simPaused = false;
  }

  public enableSimBridgeClientData(): void {
    if (!this.simBridgeClientUsed) {
      this.logging.info('SimBridge client data received, ignoring SimConnect aircraftStatusUpdate from now on.');
    }
    this.simBridgeClientUsed = true;
  }

  private onPositionUpdate(data: PositionData): void {
    if (this.initialized === false) return;

    if (this.mapHandler !== null) this.mapHandler.positionUpdate(data);
  }

  private updateRendering(side: DisplaySide, status: AircraftStatus) {
    if (this.displayRendering[side].navigationDisplay === null) return;

    const configuration = side === DisplaySide.Left ? status.efisDataCapt : status.efisDataFO;
    const lastConfig = this.displayRendering[side].navigationDisplay.displayConfiguration();

    this.forceRedraw ||= this.manualAzimEnabled !== status.manualAzimEnabled;

    const configChanged =
      lastConfig !== null &&
      (lastConfig.efisMode !== configuration.efisMode ||
        lastConfig.ndRange !== configuration.ndRange ||
        lastConfig.arcMode !== configuration.arcMode ||
        lastConfig.terrOnNd !== configuration.terrOnNd ||
        lastConfig.terrOnVd !== configuration.terrOnVd);
    const stopRendering =
      lastConfig !== null &&
      ((lastConfig.terrOnNd && !configuration.terrOnNd) || (lastConfig.terrOnVd && !configuration.terrOnVd));
    const startRendering = configChanged || this.forceRedraw || (lastConfig === null && configuration !== null);

    if (stopRendering || startRendering) {
      if (this.displayRendering[side].durationInterval !== null) {
        clearInterval(this.displayRendering[side].durationInterval);
        this.displayRendering[side].durationInterval = null;
      }
      if (this.displayRendering[side].timeout !== null) {
        clearTimeout(this.displayRendering[side].timeout);
        this.displayRendering[side].timeout = null;
      }

      this.displayRendering[side].navigationDisplay.reset();
      this.displayRendering[side].verticalDisplay.reset();

      // reset also the aircraft data
      this.simconnect.sendNavigationDisplayTerrainMapMetadata(
        side,
        this.displayRendering[side].navigationDisplay.displayData(),
      );
    }

    this.displayRendering[side].navigationDisplay.aircraftStatusUpdate(status, side, false);
    this.displayRendering[side].verticalDisplay.aircraftStatusUpdate(status, side);

    if (!this.displayRendering[side].verticalDisplay.hasPath()) {
      this.manualAzimEndPoint = projectWgs84(
        status.latitude,
        status.longitude,
        status.heading,
        160 * NauticalMilesToMetres,
      );
      this.displayRendering[side].verticalDisplay.pathDataUpdate({
        side: side,
        pathWidth: 1.0,
        trackChangesSignificantlyAtDistance: 0,
        waypoints: [{ latitude: this.manualAzimEndPoint[0], longitude: this.manualAzimEndPoint[1] }],
      });
    }

    if (startRendering) {
      this.startNavigationDisplayRenderingCycle(side);
    }
    this.forceRedraw = false;
  }

  private updatePathData(side: DisplaySide, path: VerticalPathData) {
    this.forceRedraw ||= this.displayRendering[side].verticalDisplay.numPathElements() !== path.waypoints.length;
    if (this.manualAzimEnabled || path.waypoints.length === 0) {
      const waypoints =
        this.manualAzimEndPoint === null
          ? []
          : [{ latitude: this.manualAzimEndPoint[0], longitude: this.manualAzimEndPoint[1] }];
      this.displayRendering[side].verticalDisplay.pathDataUpdate({
        side: side,
        pathWidth: 1.0,
        trackChangesSignificantlyAtDistance: 0,
        waypoints: waypoints,
      });
    } else {
      this.displayRendering[side].verticalDisplay.pathDataUpdate(path);
    }
  }

  public onAircraftStatusUpdate(data: AircraftStatus): void {
    if (this.initialized === false || !data) return;

    // eslint-disable-next-line no-bitwise
    this.verticalDisplayRequired =
      (data.navigationDisplayRenderingMode & TerrainRenderingMode.VerticalDisplayRequired) ===
      TerrainRenderingMode.VerticalDisplayRequired;

    // eslint-disable-next-line no-bitwise
    this.renderingMode =
      data.navigationDisplayRenderingMode & (TerrainRenderingMode.ArcMode | TerrainRenderingMode.ScanlineMode);

    this.manualAzimEnabled = data.manualAzimEnabled;
    this.manualAzimDegrees = data.manualAzimDegrees;
    this.manualAzimEndPoint = data.manualAzimEnabled
      ? projectWgs84(data.latitude, data.longitude, this.manualAzimDegrees, 160 * NauticalMilesToMetres)
      : null;

    if (this.verticalDisplayRequired === true) {
      this.displayDimension.height = DisplayScreenPixelHeightWithVerticalDisplay;
    } else {
      this.displayDimension.height = DisplayScreenPixelHeightWithoutVerticalDisplay;
    }
    this.displayDimension.width = NavigationDisplayMaxPixelWidth;

    if (this.mapHandler !== null) this.mapHandler.aircraftStatusUpdate(data);
    this.updateRendering(DisplaySide.Left, data);
    this.updateRendering(DisplaySide.Right, data);
  }

  public onVerticalPathDataUpdate(data: VerticalPathData): void {
    if (this.initialized === false) return;

    this.updatePathData(data.side, data);
  }

  constructor(public logging: Logger) {
    this.simconnect = new SimConnect(this.logging);
    this.simconnect.addUpdateCallback('reset', () => this.onReset());
    this.simconnect.addUpdateCallback('paused', () => this.onPaused());
    this.simconnect.addUpdateCallback('unpaused', () => this.onUnpaused());
    this.simconnect.addUpdateCallback('positionUpdate', (data: PositionData) => this.onPositionUpdate(data));
    this.simconnect.addUpdateCallback('aircraftStatusUpdate', (data: AircraftStatus) => {
      if (!this.simBridgeClientUsed) {
        // Only react to SimConnect updates for AircraftStatus if no SimBridge-Client data has been received
        this.onAircraftStatusUpdate(data);
      }
    });

    this.gpu = new GPU({ mode: GpuProcessingActive === true ? 'gpu' : 'cpu' });

    const startupTime = new Date().getTime();

    /* create the map handler */
    this.mapHandler = new MapHandler(this.logging, this.gpu);

    /* create the sides */
    this.displayRendering.L = {
      timeout: null,
      durationInterval: null,
      startupTimestamp: startupTime,
      navigationDisplay: new NavigationDisplayRenderer(this.mapHandler, this.logging, this.gpu, startupTime),
      renderedLastFrameNavigationDisplay: false,
      verticalDisplay: new VerticalDisplayRenderer(this.mapHandler, this.logging, this.gpu, startupTime),
      renderedLastFrameVerticalDisplay: false,
      cycleData: {
        timestamp: 0,
        thresholds: null,
        frames: null,
      },
    };
    this.displayRendering.R = {
      timeout: null,
      durationInterval: null,
      // offset the rendering to have a more realistic bahaviour
      startupTimestamp: startupTime - 1500,
      navigationDisplay: new NavigationDisplayRenderer(this.mapHandler, this.logging, this.gpu, startupTime - 1500),
      renderedLastFrameNavigationDisplay: false,
      verticalDisplay: new VerticalDisplayRenderer(this.mapHandler, this.logging, this.gpu, startupTime - 1500),
      renderedLastFrameVerticalDisplay: false,
      cycleData: {
        timestamp: 0,
        thresholds: null,
        frames: null,
      },
    };

    this.mapHandler.initialize().then((initialized) => {
      if (initialized === true) {
        this.logging.info('Initialized the map handler');

        const startupNdConfigL: EfisData = {
          ndRange: 20,
          arcMode: true,
          terrOnNd: true,
          terrOnVd: true,
          efisMode: 0,
          vdRangeLower: -500,
          vdRangeUpper: 24000,
          mapOffsetX: 0,
          mapWidth: NavigationDisplayMaxPixelWidth,
          mapHeight: NavigationDisplayMaxPixelHeight,
          centerOffsetY: 0,
        };
        const startupNdConfigR: EfisData = {
          ndRange: 10,
          arcMode: true,
          terrOnNd: false,
          terrOnVd: false,
          efisMode: 0,
          vdRangeLower: -500,
          vdRangeUpper: 24000,
          mapOffsetX: 0,
          mapWidth: NavigationDisplayMaxPixelWidth,
          mapHeight: NavigationDisplayMaxPixelHeight,
          centerOffsetY: 0,
        };
        const startupStatus: AircraftStatus = {
          adiruDataValid: true,
          tawsInop: false,
          latitude: 47.26081085205078,
          longitude: 11.349658966064453,
          altitude: 1904,
          heading: 260,
          verticalSpeed: 0,
          gearIsDown: true,
          runwayDataValid: false,
          runwayLatitude: 0.0,
          runwayLongitude: 0.0,
          efisDataCapt: startupNdConfigL,
          efisDataFO: startupNdConfigR,
          navigationDisplayRenderingMode: TerrainRenderingMode.ArcMode,
          manualAzimEnabled: false,
          manualAzimDegrees: 0,
          groundTruthLatitude: 47.26081085205078,
          groundTruthLongitude: 11.349658966064453,
        };

        this.displayRendering.L.navigationDisplay.aircraftStatusUpdate(startupStatus, DisplaySide.Left, true);
        this.displayRendering.R.navigationDisplay.aircraftStatusUpdate(startupStatus, DisplaySide.Right, true);
        this.displayRendering.L.verticalDisplay.aircraftStatusUpdate(startupStatus, DisplaySide.Left);
        this.displayRendering.R.verticalDisplay.aircraftStatusUpdate(startupStatus, DisplaySide.Right);

        Promise.all([
          this.displayRendering.L.navigationDisplay.initialize(),
          this.displayRendering.R.navigationDisplay.initialize(),
          this.displayRendering.L.verticalDisplay.initialize(),
          this.displayRendering.R.verticalDisplay.initialize(),
        ]).then((ndInitialized) => {
          if (ndInitialized.every((v) => v === true) === true) {
            this.logging.info('Initialized the ND renderers');
          } else {
            this.logging.error('Unable to initialize the ND renderers');
          }

          this.mapHandler.reset();
          this.displayRendering.L.navigationDisplay.reset();
          this.displayRendering.R.navigationDisplay.reset();
          this.displayRendering.L.verticalDisplay.reset();
          this.displayRendering.R.verticalDisplay.reset();

          this.initialized = true;
          this.logging.info('Terrainmap worker initialized');
        });
      } else {
        this.logging.error('Unable to initialize the map handler');
      }
    });
  }

  private resetRendering(side: DisplaySide): void {
    if (this.displayRendering[side].durationInterval !== null) {
      clearInterval(this.displayRendering[side].durationInterval);
      this.displayRendering[side].durationInterval = null;
    }
    if (this.displayRendering[side].timeout !== null) {
      clearTimeout(this.displayRendering[side].timeout);
      this.displayRendering[side].timeout = null;
    }
    if (this.displayRendering[side].navigationDisplay !== null) {
      this.displayRendering[side].navigationDisplay.reset();
      this.displayRendering[side].verticalDisplay.reset();

      this.simconnect.sendNavigationDisplayTerrainMapMetadata(
        side,
        this.displayRendering[side].navigationDisplay.displayData(),
      );
    }
  }

  public stopRendering(): void {
    this.resetRendering(DisplaySide.Left);
    this.resetRendering(DisplaySide.Right);
  }

  public shutdown(): void {
    this.stopRendering();

    if (this.displayRendering.L.navigationDisplay !== null) this.displayRendering.L.navigationDisplay.shutdown();
    if (this.displayRendering.R.navigationDisplay !== null) this.displayRendering.R.navigationDisplay.shutdown();
    if (this.mapHandler !== null) this.mapHandler.shutdown();

    if (this.simconnect !== null) this.simconnect.terminate();
    if (this.gpu !== null) this.gpu.destroy();
  }

  private createScreenResolutionFrame(
    side: DisplaySide,
    navigationDisplay: Uint8ClampedArray | null,
    verticalDisplay: Uint8ClampedArray | null,
  ): Uint8ClampedArray {
    const result = new Uint8ClampedArray(
      this.displayDimension.width * RenderingColorChannelCount * this.displayDimension.height,
    );

    // access data as uint32-array for performance reasons
    const destination = new Uint32Array(result.buffer);
    // UInt32-version of RGBA (4, 4, 5, 0)
    destination.fill(328708);

    if (navigationDisplay !== null) {
      const source = new Uint32Array(navigationDisplay.buffer);
      const displayConfiguration = this.displayRendering[side].navigationDisplay.displayConfiguration();

      // manual iteration is 2x faster compared to splice
      for (let y = 0; y < displayConfiguration.mapHeight; ++y) {
        let destinationIndex =
          (NavigationDisplayMapStartOffsetY + y) * this.displayDimension.width + displayConfiguration.mapOffsetX;
        let sourceIndex = y * displayConfiguration.mapWidth;

        for (let x = 0; x < displayConfiguration.mapWidth; ++x) {
          destination[destinationIndex] = source[sourceIndex];
          destinationIndex++;
          sourceIndex++;
        }
      }
    }

    // add the vertical display map
    if (verticalDisplay !== null) {
      const source = new Uint32Array(verticalDisplay.buffer);
      const displayConfiguration = this.displayRendering[side].verticalDisplay.displayConfiguration();

      for (let y = 0; y < displayConfiguration.mapHeight; ++y) {
        let destinationIndex =
          (VerticalDisplayMapStartOffsetY + y) * this.displayDimension.width + VerticalDisplayMapStartOffsetX;
        let sourceIndex = y * displayConfiguration.mapWidth;

        for (let x = 0; x < displayConfiguration.mapWidth; ++x) {
          destination[destinationIndex++] = source[sourceIndex++];
        }
      }
    }

    return result;
  }

  public startNavigationDisplayRenderingCycle(side: DisplaySide): void {
    const verticalDisplayRenderedOnSide =
      this.verticalDisplayRequired &&
      this.displayRendering[side].navigationDisplay.displayConfiguration().terrOnVd &&
      [2, 3].includes(this.displayRendering[side].navigationDisplay.displayConfiguration().efisMode);

    const navigationDisplayRenderedOnSide =
      this.displayRendering[side].navigationDisplay.displayConfiguration().terrOnNd;

    if (this.displayRendering[side].timeout !== null) {
      clearTimeout(this.displayRendering[side].timeout);
      this.displayRendering[side].timeout = null;
    }
    if (this.displayRendering[side].durationInterval !== null) {
      clearInterval(this.displayRendering[side].durationInterval);
      this.displayRendering[side].durationInterval = null;
    }

    const currentTime = new Date().getTime();
    this.displayRendering[side].renderedLastFrameNavigationDisplay = false;
    this.displayRendering[side].renderedLastFrameVerticalDisplay = false;
    this.displayRendering[side].navigationDisplay.startNewMapCycle(currentTime);
    if (verticalDisplayRenderedOnSide) {
      this.displayRendering[side].verticalDisplay.startNewMapCycle(currentTime);
    }
    this.displayRendering[side].cycleData.frames = [];

    this.displayRendering[side].durationInterval = setInterval(() => {
      if (this.displayRendering[side].renderedLastFrameNavigationDisplay === false) {
        this.displayRendering[side].renderedLastFrameNavigationDisplay =
          this.displayRendering[side].navigationDisplay.render();
      }
      const ndMap = this.displayRendering[side].navigationDisplay.currentFrame();

      let vdMap: Uint8ClampedArray | null = null;
      if (verticalDisplayRenderedOnSide) {
        if (this.displayRendering[side].renderedLastFrameVerticalDisplay === false) {
          this.displayRendering[side].renderedLastFrameVerticalDisplay =
            this.displayRendering[side].verticalDisplay.render();
        }
        vdMap = this.displayRendering[side].verticalDisplay.currentFrame();
      } else {
        this.displayRendering[side].renderedLastFrameVerticalDisplay = true;
      }

      const frame = this.createScreenResolutionFrame(side, navigationDisplayRenderedOnSide ? ndMap : null, vdMap);

      if (frame !== null && this.simPaused === false) {
        sharp(frame, {
          raw: {
            width: this.displayDimension.width,
            height: this.displayDimension.height,
            channels: RenderingColorChannelCount,
          },
        })
          .png()
          .toBuffer()
          .then((buffer) => {
            const displayData = this.displayRendering[side].navigationDisplay.displayData();
            displayData.FrameByteCount = buffer.byteLength;
            displayData.FirstFrame = this.displayRendering[side].cycleData.frames.length === 0;

            if (!navigationDisplayRenderedOnSide) {
              // metadata is used in the TERRONND WASM module to detect frame changes, so we still have to send it even though ND TERR would be disabled on the A380X
              // Send negative values for the thresholds in order to hide them instead
              displayData.MinimumElevation = -1;
              displayData.MaximumElevation = -1;
            }

            this.simconnect.sendNavigationDisplayTerrainMapMetadata(side, displayData);
            this.simconnect.sendNavigationDisplayTerrainMapFrame(side, buffer);

            // store the data for the web UI
            this.displayRendering[side].cycleData.frames.push(new Uint8ClampedArray(buffer));
          });
      }

      if (
        this.displayRendering[side].renderedLastFrameNavigationDisplay === true &&
        this.displayRendering[side].renderedLastFrameVerticalDisplay === true
      ) {
        if (this.displayRendering[side].durationInterval !== null) {
          clearInterval(this.displayRendering[side].durationInterval);
          this.displayRendering[side].durationInterval = null;
        }

        this.displayRendering[side].cycleData.thresholds = {
          minElevation: this.displayRendering[side].navigationDisplay.displayData().MinimumElevation,
          minElevationIsWarning:
            this.displayRendering[side].navigationDisplay.displayData().MinimumElevationMode ===
            TerrainLevelMode.Warning,
          minElevationIsCaution:
            this.displayRendering[side].navigationDisplay.displayData().MinimumElevationMode ===
            TerrainLevelMode.Caution,
          maxElevation: this.displayRendering[side].navigationDisplay.displayData().MaximumElevation,
          maxElevationIsWarning:
            this.displayRendering[side].navigationDisplay.displayData().MaximumElevationMode ===
            TerrainLevelMode.Warning,
          maxElevationIsCaution:
            this.displayRendering[side].navigationDisplay.displayData().MaximumElevationMode ===
            TerrainLevelMode.Warning,
        };

        if (this.displayRendering[side].timeout !== null) {
          clearTimeout(this.displayRendering[side].timeout);
          this.displayRendering[side].timeout = null;
        }

        if (
          this.displayRendering[side].navigationDisplay.displayConfiguration().terrOnNd ||
          this.displayRendering[side].navigationDisplay.displayConfiguration().terrOnVd
        ) {
          const timeout =
            this.renderingMode === TerrainRenderingMode.ArcMode
              ? RenderingMapUpdateTimeoutArcMode
              : RenderingMapUpdateTimeoutScanlineMode;
          this.displayRendering[side].timeout = setTimeout(
            () => this.startNavigationDisplayRenderingCycle(side),
            timeout,
          );
        }
      }
    }, RenderingMapTransitionDeltaTime);
  }

  public frameData(side: string): {
    side: string;
    timestamp: number;
    thresholds: NavigationDisplayThresholdsDto;
    frames: Uint8ClampedArray[];
  } {
    if (side in this.displayRendering) {
      return {
        side,
        timestamp: this.displayRendering[side].cycleData.timestamp,
        thresholds: this.displayRendering[side].cycleData.thresholds,
        frames: this.displayRendering[side].cycleData.frames,
      };
    }

    return { side, timestamp: 0, thresholds: null, frames: [] };
  }
}

const terrainWorker = new TerrainWorker(new ThreadLogger());

parentPort.on('message', (data: MainToWorkerThreadMessage) => {
  if (data.type === MainToWorkerThreadMessageTypes.FrameData) {
    parentPort.postMessage({
      type: WorkerToMainThreadMessageTypes.FrameData,
      content: terrainWorker.frameData(data.content),
    });
  } else if (data.type === MainToWorkerThreadMessageTypes.Shutdown) {
    terrainWorker.shutdown();
  } else if (data.type === MainToWorkerThreadMessageTypes.AircraftStatusData) {
    terrainWorker.enableSimBridgeClientData();
    terrainWorker.onAircraftStatusUpdate(data.content);
  } else if (data.type === MainToWorkerThreadMessageTypes.VerticalDisplayPath) {
    terrainWorker.onVerticalPathDataUpdate(data.content);
  }
});
