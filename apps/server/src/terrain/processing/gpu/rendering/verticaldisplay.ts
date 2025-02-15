import { VerticalDisplayParameters } from '../interfaces';

export function renderVerticalDisplay(
  this: VerticalDisplayParameters,
  elevationProfile: number[],
  minimumAltitude: number,
  maximumAltitude: number,
  greyBackgroundFromX: number,
): number {
  const pixelX = Math.floor(this.thread.x / 4);
  const colorChannel = this.thread.x % 4;

  if (pixelX >= this.constants.elevationProfileEntryCount) {
    return [0, 0, 0, 0][colorChannel];
  }

  const elevation = elevationProfile[pixelX];
  if (elevation === this.constants.invalidElevation || elevation === this.constants.unknownElevation) {
    return [255, 148, 255, 255][colorChannel];
  }

  const stepY = (maximumAltitude - minimumAltitude) / this.constants.maxImageHeight;
  const altitude = (this.constants.maxImageHeight - this.thread.y) * stepY + minimumAltitude;

  // altitude is above the elevation -> draw the background
  if (altitude > elevation) {
    if (greyBackgroundFromX >= 0 && pixelX >= greyBackgroundFromX) {
      return [100, 100, 100, 255][colorChannel];
    } else {
      return [0, 0, 0, 0][colorChannel];
    }
  }

  // elevation is water -> check if we draw the water until 0
  if (elevation === this.constants.waterElevation) {
    if (altitude <= 0) {
      return [0, 255, 255, 255][colorChannel];
    }
    return [0, 0, 0, 0][colorChannel];
  }

  // draw the obstacle
  return [160, 83, 34, 255][colorChannel];
}
