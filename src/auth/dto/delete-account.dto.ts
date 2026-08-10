import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class DeleteAccountDto {
  @ApiProperty({
    description: 'Current account password, required to delete the account',
  })
  @IsString()
  @MinLength(1)
  password!: string;
}
