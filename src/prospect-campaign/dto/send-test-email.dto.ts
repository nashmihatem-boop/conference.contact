import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class SendTestEmailDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(200)
  email!: string;
}
