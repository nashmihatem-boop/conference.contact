import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  COMPANY_SIZE_RANGES,
  PERSON_SENIORITIES,
  VERIFIED_PERSON_FUNCTIONS,
} from '../apollo-taxonomy';

const COMPANY_SIZE_VALUES = COMPANY_SIZE_RANGES.map((r) => r.value);

/**
 * The full structured filter set from the review-parameters panel — this is
 * what actually runs, not the free-text query (that only ever fed
 * ParseQueryDto, one step earlier, to produce a first draft of these same
 * fields). `campaignName` is stored as LeadSearchJob.query, doubling as the
 * label shown in History.
 */
export class AiSearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  campaignName!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  searchKeywords?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  targetIndustries?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  personTitles?: string[];

  @ApiPropertyOptional({ enum: PERSON_SENIORITIES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PERSON_SENIORITIES.length)
  @IsIn(PERSON_SENIORITIES, { each: true })
  personSeniorities?: string[];

  @ApiPropertyOptional({ enum: VERIFIED_PERSON_FUNCTIONS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(VERIFIED_PERSON_FUNCTIONS.length)
  @IsIn(VERIFIED_PERSON_FUNCTIONS, { each: true })
  personFunctions?: string[];

  @ApiPropertyOptional({ example: 'Boston, MA' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({ enum: COMPANY_SIZE_VALUES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COMPANY_SIZE_VALUES.length)
  @IsIn(COMPANY_SIZE_VALUES, { each: true })
  companySizeRanges?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  revenueMin?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  revenueMax?: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'Company keyword tags to exclude from results.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  exclusions?: string[];

  @ApiPropertyOptional({
    description:
      'Set only for a direct lookup of one specific named person — every other field is ignored when this is set.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  personName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  personOrganization?: string;
}
