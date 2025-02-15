import { deg2rad, rad2deg } from '../generic/helper';

export function normalizeHeading(angle: number): number {
  return angle - Math.floor(angle / 360.0) * 360.0;
}

export function projectWgs84(latitude: number, longitude: number, bearing: number, distance: number): [number, number] {
  const latRad = deg2rad(latitude);
  const longRad = deg2rad(longitude);
  const bearingRad = deg2rad(bearing);
  const ratio = distance / 6371010.0;

  let latDest = Math.asin(
    Math.sin(latRad) * Math.cos(ratio) + Math.cos(latRad) * Math.sin(ratio) * Math.cos(bearingRad),
  );
  let longDest =
    longRad +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(ratio) * Math.cos(latRad),
      Math.cos(ratio) - Math.sin(latRad) * Math.sin(latDest),
    );

  // ensure that the latitude is between [-90.0, 90.0]
  latDest = rad2deg(latDest);
  if (latDest < -90.0) latDest = -180.0 - latDest;
  if (latDest > 90.0) latDest = 180.0 - latDest;

  // ensure that the longitude is between [-180.0, 180.0]
  longDest = rad2deg(longDest);
  if (longDest < -180.0) longDest = 360.0 + longDest;
  if (longDest > 180.0) longDest -= 360.0;

  return [latDest, longDest];
}

export function bearingWgs84(latitude0: number, longitude0: number, latitude1: number, longitude1: number): number {
  const startLat = deg2rad(latitude0);
  const startLong = deg2rad(longitude0);
  const endLat = deg2rad(latitude1);
  const endLong = deg2rad(longitude1);

  const y = Math.sin(endLong - startLong) * Math.cos(endLat);
  const x =
    Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(endLong - startLong);
  const bearing = Math.atan2(y, x) + Math.PI;

  return (rad2deg(bearing) + 360) % 360;
}

export function wgs84toPixelCoordinate(
  latitude: number,
  projectedLatitude: number,
  projectedLongitude: number,
  groundTruthLatitude: number,
  groundTruthLongitude: number,
  worldMapSouthwestLat: number,
  worldMapSouthwestLong: number,
  worldMapNortheastLat: number,
  worldMapNortheastLong: number,
  worldMapWidth: number,
  worldMapHeight: number,
  currentWorldGridX: number,
  currentWorldGridY: number,
): [number, number] {
  let latStep = 0.0;
  if (worldMapSouthwestLat >= latitude) {
    // we are at the south pole
    latStep = worldMapSouthwestLat + worldMapNortheastLat + 180.0;
  } else if (worldMapNortheastLat <= latitude) {
    // we are at the north pole
    latStep = 180.0 - worldMapSouthwestLat - worldMapNortheastLat;
  } else {
    latStep = worldMapNortheastLat - worldMapSouthwestLat;
  }
  latStep /= worldMapHeight;

  // get the longitudinal step and check for 180 deg wrap arounds
  let longStep = 0.0;
  if (worldMapNortheastLong < worldMapSouthwestLong) {
    longStep = 180.0 - worldMapSouthwestLong + Math.abs(worldMapNortheastLong + 180.0);
  } else {
    longStep = worldMapNortheastLong - worldMapSouthwestLong;
  }
  longStep /= worldMapWidth;

  // calculate the pixel movement out of the current position
  const latPixelDelta = (groundTruthLatitude - projectedLatitude) / latStep;

  // calculate the pixel delta and check for wrap around situation at 180 deg
  let longPixelDelta = 0.0;
  if (Math.abs(projectedLongitude - groundTruthLongitude) >= 180.0) {
    if (projectedLongitude > groundTruthLatitude) {
      longPixelDelta = 180.0 - projectedLongitude + Math.abs(groundTruthLongitude) - 180.0;
    } else {
      longPixelDelta = 180.0 - groundTruthLongitude + Math.abs(projectedLongitude) - 180.0;
    }
  } else {
    longPixelDelta = projectedLongitude - groundTruthLongitude;
  }
  longPixelDelta /= longStep;

  return [Math.round(currentWorldGridX + longPixelDelta), Math.round(currentWorldGridY + latPixelDelta)];
}

export function verticalDisplayDistanceToPixelX(distance: number, range: number): number {
  return (distance / range) * 540;
}
