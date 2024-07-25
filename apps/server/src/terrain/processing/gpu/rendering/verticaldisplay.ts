import { VerticalDisplayParameters } from '../interfaces';

export function renderVerticalDisplay(
  this: VerticalDisplayParameters,
  elevationProfile: number[],
  minimumAltitude: number,
  maximumAltitude: number,
): number {
  const pixelX = Math.floor(this.thread.x / 4);
  const colorChannel = this.thread.x % 4;

  if (pixelX >= this.constants.elevationProfileEntryCount) {
    return [4, 4, 5, 255][colorChannel];
  }

  const elevation = elevationProfile[pixelX];
  if (elevation === this.constants.invalidElevation || elevation === this.constants.unknownElevation) {
    return [255, 148, 255, 255][colorChannel];
  }

  const stepY = (maximumAltitude - minimumAltitude) / this.constants.maxImageHeight;
  const altitude = (this.constants.maxImageHeight - this.thread.y) * stepY + minimumAltitude;

  // altitude is above the elevation -> draw the background
  if (altitude > elevation) {
    return [4, 4, 5, 255][colorChannel];
  }

  // elevation is water -> check if we draw the water until 0
  if (elevation === this.constants.waterElevation) {
    if (altitude <= 0) {
      return [0, 255, 255, 255][colorChannel];
    }
    return [4, 4, 5, 255][colorChannel];
  }

  // draw the obstacle
  return [59, 21, 0, 255][colorChannel];
}
