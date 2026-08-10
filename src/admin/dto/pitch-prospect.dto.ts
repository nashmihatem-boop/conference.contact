import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum ProspectPitchTemplate {
  INTRO = 'INTRO',
  VALUE = 'VALUE',
  URGENCY = 'URGENCY',
}

export class PitchProspectDto {
  @ApiProperty({ enum: ProspectPitchTemplate })
  @IsEnum(ProspectPitchTemplate)
  template!: ProspectPitchTemplate;
}
