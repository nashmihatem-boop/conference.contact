import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { Role } from '../../../generated/prisma/enums';

export class InviteUserDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiPropertyOptional({ enum: Role, default: Role.USER })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({
    default: true,
    description:
      'Grants Directory access on signup, without a real subscription.',
  })
  @IsOptional()
  @IsBoolean()
  grantDirectoryAccess?: boolean;
}
