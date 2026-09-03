import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateEmailTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  heading?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ctaLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  footnote?: string;

  // No @MinLength here deliberately — an empty string is a valid "clear
  // back to the default address" signal (see updateEmailTemplate), and a
  // non-empty-but-too-short value is rejected there instead, since
  // class-validator can't express "empty is fine, but 3 chars isn't" with
  // decorators alone.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  mailingAddress?: string;
}
