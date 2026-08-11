import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class UnsubscribeDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  token!: string;
}
