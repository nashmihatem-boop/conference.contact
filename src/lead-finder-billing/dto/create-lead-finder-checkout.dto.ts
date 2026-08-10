import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateLeadFinderCheckoutDto {
  @ApiProperty({ description: 'LeadFinderTier.slug — e.g. "starter"' })
  @IsString()
  tierSlug!: string;
}
