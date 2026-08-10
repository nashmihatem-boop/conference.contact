import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReplyContactMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message!: string;
}
