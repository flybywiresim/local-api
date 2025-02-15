import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNumber } from 'class-validator';
import { WaypointDto } from './waypoint.dto';
import { Type } from 'class-transformer';

export class ElevationSamplePathDto {
  @ApiProperty({ description: 'Width of FMS path (dictated by e.g. RNP)', example: '1.0' })
  @IsNumber()
  pathWidth: number;

  @ApiProperty({
    description:
      'After which distance from the aircraft the track changes significantly (by more than 3 degrees). Will be drawn with a grey background',
    example: '5.0',
  })
  @IsNumber()
  trackChangesSignificantlyAtDistance: number;

  @ApiProperty({ description: 'The array of all FMS waypoints of the active flight plan', type: [WaypointDto] })
  @Type(() => WaypointDto)
  @IsArray()
  waypoints: WaypointDto[];
}
