import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber } from 'class-validator';

export class TawsEfisDataDto {
  @ApiProperty({ description: 'ND range', example: '40' })
  @IsNumber()
  ndRange: number;

  @ApiProperty({ description: 'ND is in ARC mode', example: 'true' })
  @IsBoolean()
  arcMode: boolean;

  @ApiProperty({ description: 'TERR (ON ND) is selected', example: 'true' })
  @IsBoolean()
  terrOnNd: boolean;

  @ApiProperty({
    description: 'TERR (ON VD) is selected. Always true for A380X, always false for A32NX.',
    example: 'false',
  })
  @IsBoolean()
  terrOnVd: boolean;

  @ApiProperty({ description: 'EFIS mode enum', example: '1' })
  @IsNumber()
  efisMode: number;

  @ApiProperty({ description: 'Lower display limit of VD, in feet', example: '-500' })
  @IsNumber()
  vdRangeLower: number;

  @ApiProperty({ description: 'Upper display limit of VD, in feet', example: '28000' })
  @IsNumber()
  vdRangeUpper: number;
}
