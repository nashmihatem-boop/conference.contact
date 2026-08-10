import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Free-text query in, structured filters out — no job created, no credits
 * spent. Powers the review-parameters panel: the user sees what Claude
 * inferred and can edit it before POST /leads/ai-search actually runs.
 */
export class ParseQueryDto {
  @ApiProperty({
    example:
      'CTOs at healthcare startups in Boston with less than 50 employees',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  query!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  jobTitles?: string[];
}
