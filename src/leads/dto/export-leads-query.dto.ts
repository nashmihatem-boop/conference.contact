import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CompanyType } from '../../../generated/prisma/enums';
import { ParseQueryBoolean } from '../../common/dto/parse-query-boolean.decorator';
import { UNCLASSIFIED } from '../constants';

/** Same filters as ListLeadsQueryDto, no pagination — export streams every matching row, not a page of them. */
export class ExportLeadsQueryDto {
  @ApiPropertyOptional({ enum: [...Object.values(CompanyType), UNCLASSIFIED] })
  @IsOptional()
  @IsIn([...Object.values(CompanyType), UNCLASSIFIED])
  companyType?: CompanyType | typeof UNCLASSIFIED;

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
