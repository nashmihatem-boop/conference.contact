import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The public, no-account AI Lead Finder demo — just the free-text query.
 * No campaign name, no editable filter panel: this is a one-shot preview,
 * not a saved search a signed-out visitor could come back to.
 */
export class AnonymousAiSearchDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  query!: string;
}
