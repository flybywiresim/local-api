import { DisplaySide } from 'apps/server/src/terrain/types/display';

export enum TerrainRenderingMode {
  ArcMode = 0,
  ScanlineMode = 1,
  VerticalDisplayRequired = 2,
}

export interface EfisData {
  ndRange: number;
  arcMode: boolean;
  terrOnNd: boolean;
  terrOnVd: boolean;
  efisMode: number;
  vdRangeLower: number;
  vdRangeUpper: number;
  mapOffsetX?: number;
  mapWidth?: number;
  mapHeight?: number;
  centerOffsetY?: number;
}

export interface VerticalDisplay {
  range: number;
  minimumAltitude: number;
  maximumAltitude: number;
  mapWidth?: number;
  mapHeight?: number;
  fmsPathUsed?: boolean;
}

export interface AircraftStatus {
  adiruDataValid: boolean;
  tawsInop: boolean;
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  verticalSpeed: number;
  gearIsDown: boolean;
  runwayDataValid: boolean;
  runwayLatitude: number;
  runwayLongitude: number;
  efisDataCapt: EfisData;
  efisDataFO: EfisData;
  navigationDisplayRenderingMode: number;
  manualAzimEnabled: boolean;
  manualAzimDegrees: number;
  groundTruthLatitude: number;
  groundTruthLongitude: number;
}

interface VerticalPathWaypoint {
  latitude: number;
  longitude: number;
}

export interface VerticalPathData {
  side: DisplaySide;
  pathWidth: number;
  trackChangesSignificantlyAtDistance: number;
  waypoints: VerticalPathWaypoint[];
}

export enum TerrainLevelMode {
  PeaksMode = 0,
  Warning = 1,
  Caution = 2,
}

export class NavigationDisplayData {
  public MinimumElevation: number = Infinity;

  public MinimumElevationMode: TerrainLevelMode = TerrainLevelMode.PeaksMode;

  public MaximumElevation: number = Infinity;

  public MaximumElevationMode: TerrainLevelMode = TerrainLevelMode.PeaksMode;

  public FirstFrame: boolean = false;

  public DisplayRange: number = 10;

  public DisplayMode: number = 0;

  public FrameByteCount: number = 0;
}
