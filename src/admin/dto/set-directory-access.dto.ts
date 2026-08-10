import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetDirectoryAccessDto {
  @ApiProperty()
  @IsBoolean()
  granted!: boolean;
}
