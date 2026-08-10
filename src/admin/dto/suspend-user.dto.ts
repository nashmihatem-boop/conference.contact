import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SuspendUserDto {
  @ApiPropertyOptional({ description: 'Recorded on the audit log entry' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
