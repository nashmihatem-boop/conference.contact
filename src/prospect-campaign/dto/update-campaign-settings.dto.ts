import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateCampaignSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  dailyCap?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  paused?: boolean;
}
