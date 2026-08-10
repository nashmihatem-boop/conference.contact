import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListFlaggedSessionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    default: 1,
    description: 'Only sessions with riskScore >= this value',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScore: number = 1;
}
