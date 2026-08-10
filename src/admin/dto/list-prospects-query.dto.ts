import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListProspectsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Matches against email or name.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
