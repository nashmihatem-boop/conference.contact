import { ApiProperty } from '@nestjs/swagger';
import {
  Equals,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  // Length over composition rules, per NIST 800-63B — forced "one uppercase,
  // one symbol" policies push users toward predictable substitutions
  // (Password1! ) rather than actually stronger passwords.
  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(72) // argon2/bcrypt-adjacent inputs beyond this add nothing
  password!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiProperty({
    description:
      'Must be true — registration requires accepting the current Terms and Privacy Policy.',
  })
  @Equals(true, {
    message: 'You must accept the Terms of Service and Privacy Policy',
  })
  acceptedTerms!: boolean;
}
