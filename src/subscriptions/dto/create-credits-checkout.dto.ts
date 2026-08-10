import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min } from 'class-validator';

export class CreateCreditsCheckoutDto {
  @ApiProperty({ description: 'CreditPack.slug — e.g. "credits-500"' })
  @IsString()
  packSlug!: string;

  @ApiPropertyOptional({
    description: 'Number of packs to buy in this checkout',
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  quantity: number = 1;
}
