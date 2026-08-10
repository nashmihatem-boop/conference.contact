import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { ContactReason } from '../../../generated/prisma/enums';
import { ParseQueryBoolean } from '../../common/dto/parse-query-boolean.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListContactMessagesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Filter to unhandled (false) or handled (true) messages.',
  })
  @IsOptional()
  @ParseQueryBoolean()
  @IsBoolean()
  resolved?: boolean;

  @ApiPropertyOptional({ enum: ContactReason })
  @IsOptional()
  @IsEnum(ContactReason)
  reason?: ContactReason;
}
