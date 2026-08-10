import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class Disable2faDto {
  @ApiProperty({
    description: 'Current account password, required to disable 2FA',
  })
  @IsString()
  @MinLength(1)
  password!: string;
}
