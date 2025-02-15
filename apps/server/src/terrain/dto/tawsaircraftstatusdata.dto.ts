import { ApiProperty } from '@nestjs/swagger';
import { TawsEfisDataDto } from 'apps/server/src/terrain/dto/tawsefisdata';
import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsNumber, Max, Min, ValidateNested } from 'class-validator';

export class TawsAircraftStatusDataDto {
  @ApiProperty({ description: 'Concerning ADIRU is valid', example: 'true' })
  @IsBoolean()
  adiruDataValid: boolean;

  @ApiProperty({ description: 'TAWS is INOP, i.e. disable terrain output', example: 'true' })
  @IsBoolean()
  tawsInop: boolean;

  @ApiProperty({ description: 'Aircraft latitude', example: '48.0' })
  @IsNumber()
  latitude: number;

  @ApiProperty({ description: 'Aircraft longitude', example: '11.0' })
  @IsNumber()
  longitude: number;

  @ApiProperty({ description: 'Aircraft altitude', example: '28000' })
  @IsNumber()
  altitude: number;

  @ApiProperty({ description: 'Aircraft heading', example: '263.0' })
  @IsNumber()
  heading: number;

  @ApiProperty({ description: 'Aircraft vertical speed', example: '-100' })
  @IsNumber()
  verticalSpeed: number;

  @ApiProperty({ description: 'Aircraft gear is down', example: 'true' })
  @IsBoolean()
  gearIsDown: boolean;

  @ApiProperty({ description: 'Destination data is valid', example: 'true' })
  @IsBoolean()
  runwayDataValid: boolean;

  @ApiProperty({ description: 'Arrival runway latitude', example: '48.0' })
  @IsNumber()
  runwayLatitude: number;

  @ApiProperty({ description: 'Arrival runway longitude', example: '11.0' })
  @IsNumber()
  runwayLongitude: number;

  @ApiProperty({ description: 'EFIS CP settings for CAPT', type: TawsEfisDataDto })
  @ValidateNested()
  @Type(() => TawsEfisDataDto)
  @IsDefined()
  efisDataCapt: TawsEfisDataDto;

  @ApiProperty({ description: 'EFIS CP settings for FO', type: TawsEfisDataDto })
  @ValidateNested()
  @Type(() => TawsEfisDataDto)
  @IsDefined()
  efisDataFO: TawsEfisDataDto;

  @ApiProperty({ description: 'ND ON TERR rendering mode (a/c specific)', example: '3' })
  @IsNumber()
  navigationDisplayRenderingMode: number;

  @ApiProperty({ description: 'Manual AZIM mode is enabled', example: 'false' })
  @IsBoolean()
  manualAzimEnabled: boolean;

  @ApiProperty({ description: 'Manual AZIM azimuth setting', example: '180' })
  @IsNumber()
  @Min(0)
  @Max(360)
  manualAzimDegrees: number;

  @ApiProperty({ description: 'Aircraft ground truth latitude', example: '48.0' })
  @IsNumber()
  groundTruthLatitude: number;

  @ApiProperty({ description: 'Aircraft ground truth longitude', example: '11.0' })
  @IsNumber()
  groundTruthLongitude: number;
}
