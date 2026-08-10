import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Completes a login that was paused for new-device or 2FA verification. */
export class VerifyLoginDto {
  @ApiProperty({
    description: 'Short-lived challenge token returned by POST /auth/login',
  })
  @IsString()
  challengeToken!: string;

  @ApiProperty({
    description: '6-digit code — either the emailed code or a TOTP code',
  })
  @IsString()
  @Length(6, 6)
  code!: string;
}
