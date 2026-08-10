import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CompanyType } from '../../../generated/prisma/enums';
import { ParseQueryBoolean } from '../../common/dto/parse-query-boolean.decorator';

/** Same filters as ListLeadsQueryDto, no pagination — export streams every matching row, not a page of them. */
export class ExportLeadsQueryDto {
  @ApiPropertyOptional({ enum: CompanyType })
  @IsOptional()
  @IsEnum(CompanyType)
  companyType?: CompanyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  likelyToAttend?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ParseQueryBoolean()
  @IsBoolean()
  hasEmail?: boolean;
}
