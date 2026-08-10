import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AccessTokenPayload } from '../auth/types/jwt-payload.interface';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

/** Intentionally small — passwordHash, twoFactorSecret, etc. never leave this file. */
function toProfile(user: {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  emailVerifiedAt: Date | null;
}) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async getProfile(@CurrentUser() user: AccessTokenPayload) {
    const record = await this.users.findById(user.sub);
    if (!record) throw new NotFoundException('User not found');
    return toProfile(record);
  }

  @Patch('me')
  async updateProfile(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    const updated = await this.users.updateProfile(user.sub, dto);
    return toProfile(updated);
  }
}
