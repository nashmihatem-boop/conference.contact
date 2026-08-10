import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

const SUGGEST_FIELDS = ['title', 'company'] as const;

export class SuggestQueryDto {
  @ApiProperty({ enum: SUGGEST_FIELDS })
  @IsIn(SUGGEST_FIELDS)
  field!: (typeof SUGGEST_FIELDS)[number];

  @ApiProperty({ example: 'market' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q!: string;
}
