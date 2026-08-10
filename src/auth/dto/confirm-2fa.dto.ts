import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class Confirm2faDto {
  @ApiProperty({
    description:
      '6-digit code from the authenticator app, confirming enrollment',
  })
  @IsString()
  @Length(6, 6)
  code!: string;
}
