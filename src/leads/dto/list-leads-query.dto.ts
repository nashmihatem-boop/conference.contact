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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { UNCLASSIFIED } from '../constants';

export class ListLeadsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: [...Object.values(CompanyType), UNCLASSIFIED],
    description: `Pass "${UNCLASSIFIED}" to match rows with no company type on file.`,
  })
  @IsOptional()
  @IsIn([...Object.values(CompanyType), UNCLASSIFIED])
  companyType?: CompanyType | typeof UNCLASSIFIED;

  @ApiPropertyOptional({ description: 'Exact match, e.g. "MAU Vegas 2026"' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  likelyToAttend?: string;

  @ApiPropertyOptional({
    description:
      'Case-insensitive substring match across name, company, title, email',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Only leads with a real email on file — about 27% of the dataset has none.',
  })
  @IsOptional()
  @ParseQueryBoolean()
  @IsBoolean()
  hasEmail?: boolean;

  @ApiPropertyOptional({
    description:
      'Admin-only in practice: filters to unreviewed self-submissions when false. Ignored by the public directory, which always forces approved=true.',
  })
  @IsOptional()
  @ParseQueryBoolean()
  @IsBoolean()
  approved?: boolean;
}
