import { GPU, IKernelRunShortcut, KernelOutput, Texture } from 'gpu.js';
import {
  FeetPerNauticalMile,
  GpuProcessingActive,
  InvalidElevation,
  NavigationDisplayArcModeCenterOffsetYA380X,
  NavigationDisplayArcModePixelHeightA32NX,
  NavigationDisplayArcModePixelHeightA380X,
  NavigationDisplayCenterOffsetYA32NX,
  NavigationDisplayMaxPixelHeight,
  NavigationDisplayMaxPixelWidth,
  NavigationDisplayRoseModeCenterOffsetYA380X,
  NavigationDisplayRoseModePixelHeightA32NX,
  NavigationDisplayRoseModePixelHeightA380X,
  RenderingColorChannelCount,
  RenderingMapFrameValidityTimeArcMode,
  RenderingMapFrameValidityTimeScanlineMode,
  RenderingMapTransitionDeltaTime,
  RenderingMapTransitionDurationArcMode,
  RenderingMapTransitionDurationScanlineMode,
  ThreeNauticalMilesInFeet,
  UnknownElevation,
  WaterElevation,
} from './generic/constants';
import { distanceWgs84, fastFlatten } from './generic/helper';
import { HistogramConstants, NavigationDisplayConstants } from './gpu/interfaces';
import {
  calculateNormalModeGreenThresholds,
  calculateNormalModeWarningThresholds,
  calculatePeaksModeThresholds,
  drawDensityPixel,
  renderNavigationDisplay,
  renderNormalMode,
  renderPeaksMode,
} from './gpu/rendering/navigationdisplay';
import { createArcModePatternMap, createScanlineModePatternMap } from './gpu/patterns';
import { createElevationHistogram, createLocalElevationHistogram } from './gpu/statistics';
import { uploadTextureData } from './gpu/upload';
import { Logger } from './logging/logger';
import { MapHandler } from './maphandler';
import {
  AircraftStatus,
  DisplaySide,
  EfisData,
  NavigationDisplayData,
  TerrainLevelMode,
  TerrainRenderingMode,
} from '../types';

// histogram parameters
const HistogramBinRange = 100;
const HistogramMinimumElevation = -500; // some areas in the world are below water level
const HistogramMaximumElevation = 29040; // mount everest
const HistogramBinCount = Math.ceil((HistogramMaximumElevation - HistogramMinimumElevation + 1) / HistogramBinRange);
const HistogramPatchSize = 128;

// rendering parameters
const RenderingArcModePixelWidth = 756;
const RenderingRoseModePixelWidth = 678;
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
const RenderingMapTransitionAngularStep = Math.round(
  (90 / RenderingMapTransitionDurationArcMode) * RenderingMapTransitionDeltaTime,
);

export class NavigationDisplayRenderer {
  private configuration: EfisData = null;

  private patternUpload: IKernelRunShortcut = null;

  private pixelPattern: Texture = null;

  private localHistogram: IKernelRunShortcut = null;

  private histogram: IKernelRunShortcut = null;

  private renderer: IKernelRunShortcut = null;

  private aircraftStatus: AircraftStatus = null;

  private renderingData: {
    startTransitionBorder: number;
    currentTransitionBorder: number;
    frameCounter: number;
    thresholdData: NavigationDisplayData;
    finalFrame: Uint8ClampedArray;
    lastFrame: Uint8ClampedArray;
    currentFrame: Uint8ClampedArray;
    frameValidityDuration: number;
  } = {
    startTransitionBorder: 0,
    currentTransitionBorder: 0,
    frameCounter: 0,
    thresholdData: null,
    finalFrame: null,
    lastFrame: null,
    currentFrame: null,
    frameValidityDuration: 1000,
  };

  constructor(
    private readonly maphandler: MapHandler,
    private logging: Logger,
    private readonly gpu: GPU,
    private readonly startupTime: number,
  ) {
    this.patternUpload = this.gpu
      .createKernel(uploadTextureData, {
        argumentTypes: { texture: 'Array', width: 'Integer' },
        dynamicArguments: true,
        dynamicOutput: false,
        pipeline: true,
        immutable: false,
        tactic: 'speed',
      })
      .setOutput([NavigationDisplayMaxPixelWidth, NavigationDisplayMaxPixelHeight]);

    this.localHistogram = this.gpu
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

    this.histogram = this.gpu
      .createKernel(createElevationHistogram, {
        dynamicArguments: true,
        pipeline: true,
        immutable: false,
      })
      .setLoopMaxIterations(500)
      .setOutput([HistogramBinCount]);

    this.renderer = this.gpu
      .createKernel(renderNavigationDisplay, {
        dynamicArguments: true,
        dynamicOutput: true,
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
        maxImageWidth: NavigationDisplayMaxPixelWidth,
        maxImageHeight: NavigationDisplayMaxPixelHeight,
        densityPatchSize: RenderingDensityPatchSize,
        patternMapWidth: NavigationDisplayMaxPixelWidth,
        patternMapHeight: NavigationDisplayMaxPixelHeight,
      })
      .setFunctions([
        calculateNormalModeGreenThresholds,
        calculateNormalModeWarningThresholds,
        calculatePeaksModeThresholds,
        renderNormalMode,
        renderPeaksMode,
        drawDensityPixel,
      ]);
  }

  public shutdown(): void {
    if (this.pixelPattern !== null) {
      this.pixelPattern.delete();
    }
    this.patternUpload.destroy();
    this.localHistogram.destroy();
    this.histogram.destroy();
    this.renderer.destroy();
  }

  public async initialize(): Promise<boolean> {
    this.startNewMapCycle(this.startupTime);
    return true;
  }

  private configureNavigationDisplay(config: EfisData): void {
    const lastConfig = this.configuration;
    const configChanged =
      lastConfig !== null &&
      (lastConfig.efisMode !== config.efisMode ||
        lastConfig.ndRange !== config.ndRange ||
        lastConfig.arcMode !== config.arcMode ||
        lastConfig.terrOnNd !== config.terrOnNd ||
        lastConfig.terrOnVd !== config.terrOnVd);
    const stopRendering =
      lastConfig !== null && ((lastConfig.terrOnNd && !config.terrOnNd) || (lastConfig.terrOnVd && !config.terrOnVd));
    const startRendering = configChanged || (lastConfig === null && config !== null);

    this.configuration = config;
    if (lastConfig !== null) {
      this.configuration.mapWidth = lastConfig.mapWidth;
      this.configuration.mapHeight = lastConfig.mapHeight;
      this.configuration.mapOffsetX = lastConfig.mapOffsetX;
      this.configuration.centerOffsetY = lastConfig.centerOffsetY;
    }

    if (stopRendering || startRendering) {
      this.renderingData.thresholdData = {
        MinimumElevation: -1,
        MinimumElevationMode: TerrainLevelMode.PeaksMode,
        MaximumElevation: -1,
        MaximumElevationMode: TerrainLevelMode.PeaksMode,
        FirstFrame: true,
        DisplayRange: 0,
        DisplayMode: 0,
        FrameByteCount: 0,
      };
    }
  }

  public aircraftStatusUpdate(status: AircraftStatus, side: DisplaySide, startup: boolean): void {
    if (
      this.aircraftStatus === null ||
      status.navigationDisplayRenderingMode !== this.aircraftStatus.navigationDisplayRenderingMode ||
      this.pixelPattern === null
    ) {
      let patternData: Uint8ClampedArray = null;

      // eslint-disable-next-line no-bitwise
      if (
        (status.navigationDisplayRenderingMode & TerrainRenderingMode.ScanlineMode) ===
        TerrainRenderingMode.ScanlineMode
      ) {
        patternData = createScanlineModePatternMap();
        this.renderingData.frameValidityDuration = RenderingMapFrameValidityTimeScanlineMode;
        if (startup === false) this.logging.info('Scanline-mode rendering activated');
      } else {
        patternData = createArcModePatternMap();
        this.renderingData.frameValidityDuration = RenderingMapFrameValidityTimeArcMode;
        if (startup === false) this.logging.info('ARC-mode rendering activated');
      }

      if (patternData !== null) {
        this.pixelPattern = this.patternUpload(patternData, NavigationDisplayMaxPixelWidth) as Texture;
        // some GPU drivers require the flush call to release internal memory
        if (GpuProcessingActive) this.patternUpload.context.flush();
      }
    }

    this.aircraftStatus = status;
    if (side === DisplaySide.Left) {
      this.configureNavigationDisplay(this.aircraftStatus.efisDataCapt);
    } else {
      this.configureNavigationDisplay(this.aircraftStatus.efisDataFO);
    }
  }

  private createElevationHistogram(localElevationMap: Texture): Texture {
    if (localElevationMap === null) return null;

    // create the histogram statistics
    const patchesInX = Math.ceil(this.configuration.mapWidth / HistogramPatchSize);
    const patchesInY = Math.ceil(this.configuration.mapHeight / HistogramPatchSize);
    const patchCount = patchesInX * patchesInY;

    if (this.localHistogram.output === null || this.localHistogram.output[1] !== patchCount) {
      this.localHistogram = this.localHistogram.setOutput([HistogramBinCount, patchCount]);
    }

    const localHistograms = this.localHistogram(
      localElevationMap,
      this.configuration.mapWidth,
      this.configuration.mapHeight,
    ) as Texture;
    const histogram = this.histogram(localHistograms, patchCount) as Texture;

    // some GPU drivers require the flush call to release internal memory
    if (GpuProcessingActive) {
      this.localHistogram.context.flush();
      this.histogram.context.flush();
    }

    return histogram;
  }

  private calculateAbsoluteCutOffAltitude(): number {
    if (this.aircraftStatus === null || this.aircraftStatus.runwayDataValid === false) {
      return HistogramMinimumElevation;
    }

    const destinationElevation = this.maphandler.extractElevation(
      this.aircraftStatus.runwayLatitude,
      this.aircraftStatus.runwayLongitude,
    );

    if (destinationElevation !== InvalidElevation) {
      let cutOffAltitude = RenderingCutOffAltitudeMaximum;

      const distance = distanceWgs84(
        this.aircraftStatus.latitude,
        this.aircraftStatus.longitude,
        this.aircraftStatus.runwayLatitude,
        this.aircraftStatus.runwayLongitude,
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
            const slope =
              (RenderingCutOffAltitudeMinimimum - RenderingCutOffAltitudeMaximum) / ThreeNauticalMilesInFeet;
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
      const [__, ___, maxElevation, highDensityRed, ____, lowDensityYellow, highDensityGreen, lowDensityGreen] =
        metadata;

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
      const [__, minElevation, maxElevation, ___, ____, lowDensityGreen] = metadata;

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
   * - The idea comes initially from image capturing systems and image decoding information, etc are stored in dedicated rows of one image
   * - The ND rendering reuses this idea to store the relevant information in two pixels
   *   Take a deeper look in the GPU code to get the channel and pixel encoding
   * - The statistics calculation is done on the GPU to reduce the number of transmitted data from the GPU to the CPU
   *   The reduction increases the system performance and an additional row is less time consuming than transmitting the histogram
   * - The red channel of the first pixel in the last row defines the rendering mode (0 === normal mode, 1 === peaks mode)
   */
  private createNavigationDisplayMap(elevationMap: Texture, histogram: Texture, cutOffAltitude: number): KernelOutput {
    if (elevationMap === null || histogram === null) return null;

    if (
      this.renderer.output === null ||
      this.renderer.output[0] !== this.configuration.mapWidth * RenderingColorChannelCount ||
      this.renderer.output[1] !== this.configuration.mapHeight + 1
    ) {
      this.renderer = this.renderer.setOutput([
        this.configuration.mapWidth * RenderingColorChannelCount,
        this.configuration.mapHeight + 1,
      ]);
    }

    const terrainmap = this.renderer(
      elevationMap,
      histogram,
      this.pixelPattern,
      this.configuration.mapWidth,
      this.configuration.mapHeight,
      this.aircraftStatus.altitude,
      this.aircraftStatus.verticalSpeed,
      this.aircraftStatus.gearIsDown ? RenderingGearDownOffset : RenderingNonGearDownOffset,
      cutOffAltitude,
    ) as KernelOutput;

    // some GPU drivers require the flush call to release internal memory
    if (GpuProcessingActive) this.renderer.context.flush();

    return terrainmap;
  }

  private arcModeTransitionFrame(
    oldFrame: Uint8ClampedArray,
    newFrame: Uint8ClampedArray,
    startAngle: number,
    endAngle: number,
  ): Uint8ClampedArray {
    if (newFrame === null) return null;

    const result = new Uint8ClampedArray(
      this.configuration.mapWidth * RenderingColorChannelCount * this.configuration.mapHeight,
    );

    // access data as uint32-array for performance reasons
    const destination = new Uint32Array(result.buffer);
    // UInt32-version of RGBA (4, 4, 5, 0)
    destination.fill(328708);
    const oldSource = oldFrame !== null ? new Uint32Array(oldFrame.buffer) : null;
    const newSource = new Uint32Array(newFrame.buffer);

    let arrayIndex = 0;
    for (let y = 0; y < this.configuration.mapHeight; ++y) {
      for (let x = 0; x < this.configuration.mapWidth; ++x) {
        const distance = Math.sqrt(
          (x - this.configuration.mapWidth / 2) ** 2 + (this.configuration.mapHeight - y) ** 2,
        );
        const angle = Math.acos((this.configuration.mapHeight - y) / distance) * (180.0 / Math.PI);

        if (startAngle <= angle && angle <= endAngle) {
          destination[arrayIndex] = newSource[arrayIndex];
        } else if (oldSource !== null) {
          destination[arrayIndex] = oldSource[arrayIndex];
        }

        arrayIndex++;
      }
    }

    return result;
  }

  private arcModeTransition(): boolean {
    // nothing to do here
    if (this.renderingData.finalFrame === null) return true;

    this.renderingData.thresholdData.DisplayRange = this.configuration.ndRange;
    this.renderingData.thresholdData.DisplayMode = this.configuration.efisMode;

    this.renderingData.currentTransitionBorder += RenderingMapTransitionAngularStep;

    if (this.renderingData.currentTransitionBorder < 90) {
      this.renderingData.currentFrame = this.arcModeTransitionFrame(
        this.renderingData.lastFrame,
        this.renderingData.finalFrame,
        this.renderingData.startTransitionBorder,
        this.renderingData.currentTransitionBorder,
      );

      return false;
    }

    // perform the last frame
    if (this.renderingData.currentTransitionBorder - RenderingMapTransitionAngularStep < 90) {
      this.renderingData.currentFrame = this.arcModeTransitionFrame(
        this.renderingData.lastFrame,
        this.renderingData.finalFrame,
        this.renderingData.startTransitionBorder,
        90,
      );
    }

    // do not overwrite the last frame of the initialization
    this.renderingData.lastFrame = this.renderingData.currentFrame;

    return true;
  }

  private scanlineModeTransitionFrame(oldFrame: Uint8ClampedArray, newFrame: Uint8ClampedArray): Uint8ClampedArray {
    if (newFrame === null) return null;

    const result = new Uint8ClampedArray(
      this.configuration.mapWidth * RenderingColorChannelCount * this.configuration.mapHeight,
    );

    // access data as uint32-array due to performance reasons
    const destination = new Uint32Array(result.buffer);
    // UInt32-version of RGBA (4, 4, 5, 0)
    destination.fill(328708);
    const oldSource = oldFrame !== null ? new Uint32Array(oldFrame.buffer) : null;
    const newSource = new Uint32Array(newFrame.buffer);

    let arrayIndex = 0;
    for (let y = 0; y < this.configuration.mapHeight; ++y) {
      for (let x = 0; x < this.configuration.mapWidth; ++x) {
        if (y <= this.renderingData.startTransitionBorder && y >= this.renderingData.currentTransitionBorder) {
          destination[arrayIndex] = newSource[arrayIndex];
        } else if (oldSource !== null) {
          destination[arrayIndex] = oldSource[arrayIndex];
        }

        arrayIndex++;
      }
    }

    return result;
  }

  private scanlineModeTransition(): boolean {
    // nothing to do here
    if (this.renderingData.finalFrame === null) return true;

    const verticalStep = Math.round(
      (this.configuration.mapHeight / RenderingMapTransitionDurationScanlineMode) * RenderingMapTransitionDeltaTime,
    );

    this.renderingData.thresholdData.DisplayRange = this.configuration.ndRange;
    this.renderingData.thresholdData.DisplayMode = this.configuration.efisMode;
    this.renderingData.currentTransitionBorder -= verticalStep;

    if (this.renderingData.currentTransitionBorder > 0) {
      this.renderingData.currentFrame = this.scanlineModeTransitionFrame(
        this.renderingData.lastFrame,
        this.renderingData.finalFrame,
      );

      return false;
    }

    // perform the last frame
    if (this.renderingData.currentTransitionBorder + verticalStep >= 0) {
      this.renderingData.currentFrame = this.scanlineModeTransitionFrame(
        this.renderingData.lastFrame,
        this.renderingData.finalFrame,
      );
    }

    // do not overwrite the last frame of the initialization
    this.renderingData.lastFrame = this.renderingData.currentFrame;

    return true;
  }

  public reset(): void {
    this.renderingData = {
      startTransitionBorder: 0,
      currentTransitionBorder: 0,
      frameCounter: 0,
      thresholdData: {
        MinimumElevation: -1,
        MinimumElevationMode: TerrainLevelMode.PeaksMode,
        MaximumElevation: -1,
        MaximumElevationMode: TerrainLevelMode.PeaksMode,
        FirstFrame: true,
        DisplayRange: 0,
        DisplayMode: 0,
        FrameByteCount: 0,
      },
      finalFrame: null,
      lastFrame: null,
      currentFrame: null,
      frameValidityDuration: 1000,
    };
  }

  public startNewMapCycle(currentTime: number): void {
    this.configuration.mapWidth = this.configuration.arcMode ? RenderingArcModePixelWidth : RenderingRoseModePixelWidth;
    if (
      (this.aircraftStatus.navigationDisplayRenderingMode & TerrainRenderingMode.VerticalDisplayRequired) ===
      TerrainRenderingMode.VerticalDisplayRequired
    ) {
      // Only A380X requires vertical display
      this.configuration.mapHeight = this.configuration.arcMode
        ? NavigationDisplayArcModePixelHeightA380X
        : NavigationDisplayRoseModePixelHeightA380X;
      this.configuration.centerOffsetY = this.configuration.arcMode
        ? NavigationDisplayArcModeCenterOffsetYA380X
        : NavigationDisplayRoseModeCenterOffsetYA380X;
    } else {
      this.configuration.mapHeight = this.configuration.arcMode
        ? NavigationDisplayArcModePixelHeightA32NX
        : NavigationDisplayRoseModePixelHeightA32NX;
      this.configuration.centerOffsetY = NavigationDisplayCenterOffsetYA32NX;
    }
    this.configuration.mapOffsetX = Math.ceil((NavigationDisplayMaxPixelWidth - this.configuration.mapWidth) * 0.5);

    if (this.configuration.ndRange === 0) {
      this.reset();
      return;
    }

    const elevationMap = this.maphandler.createLocalElevationMap(this.configuration);
    const histogram = this.createElevationHistogram(elevationMap);
    const cutOffAltitude = this.calculateAbsoluteCutOffAltitude();

    // create the final map
    const renderingData = this.createNavigationDisplayMap(elevationMap, histogram, cutOffAltitude);
    if (renderingData === null) return;

    const frame = renderingData as number[][];
    const metadata = frame.splice(frame.length - 1)[0];

    this.renderingData.finalFrame = new Uint8ClampedArray(fastFlatten(frame));
    this.renderingData.thresholdData = this.analyzeMetadata(metadata, cutOffAltitude);

    this.renderingData.thresholdData.DisplayRange = this.configuration.ndRange;
    this.renderingData.thresholdData.DisplayMode = this.configuration.efisMode;

    if (this.renderingData.lastFrame === null) {
      const timeSinceStart = currentTime - this.startupTime;
      const frameUpdateCount = timeSinceStart / this.renderingData.frameValidityDuration;
      const ratioSinceLastFrame = frameUpdateCount - Math.floor(frameUpdateCount);

      // eslint-disable-next-line no-bitwise
      if (
        (this.aircraftStatus.navigationDisplayRenderingMode & TerrainRenderingMode.ScanlineMode) ===
        TerrainRenderingMode.ScanlineMode
      ) {
        this.renderingData.startTransitionBorder =
          this.configuration.mapHeight - Math.floor(this.configuration.mapHeight * ratioSinceLastFrame);
      } else {
        this.renderingData.startTransitionBorder = Math.floor(90 * ratioSinceLastFrame);
      }
      // eslint-disable-next-line no-bitwise
    } else if (
      (this.aircraftStatus.navigationDisplayRenderingMode & TerrainRenderingMode.ScanlineMode) ===
      TerrainRenderingMode.ScanlineMode
    ) {
      this.renderingData.startTransitionBorder = this.configuration.mapHeight;
    } else {
      this.renderingData.startTransitionBorder = 0;
    }

    this.renderingData.currentTransitionBorder = this.renderingData.startTransitionBorder;
  }

  public render(): boolean {
    let renderingDone = false;

    // eslint-disable-next-line no-bitwise
    if (
      (this.aircraftStatus.navigationDisplayRenderingMode & TerrainRenderingMode.ScanlineMode) ===
      TerrainRenderingMode.ScanlineMode
    ) {
      renderingDone = this.scanlineModeTransition();
    } else {
      renderingDone = this.arcModeTransition();
    }

    return renderingDone;
  }

  public displayConfiguration(): EfisData {
    return this.configuration;
  }

  public displayData(): NavigationDisplayData {
    return this.renderingData.thresholdData;
  }

  public currentFrame(): Uint8ClampedArray {
    return this.renderingData.currentFrame;
  }
}
