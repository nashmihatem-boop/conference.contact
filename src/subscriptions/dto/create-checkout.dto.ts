import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateCheckoutDto {
  @ApiProperty({ description: 'Plan.slug — e.g. "full-access"' })
  @IsString()
  planSlug!: string;
}
