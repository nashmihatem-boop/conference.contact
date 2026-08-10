import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class PreviewLeadsQueryDto {
  @ApiProperty({ example: 'Affiliate Summit East 2026' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  search!: string;
}
