import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetLeadFinderAccessDto {
  @ApiProperty()
  @IsBoolean()
  granted!: boolean;
}
