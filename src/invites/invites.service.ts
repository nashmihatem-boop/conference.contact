import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly email: EmailService,
  ) {}

  /**
   * An invite only ever leads to the invitee creating their own, fully
   * independent account (see AuthService.register's reconciliation) — it
   * never grants access to the inviter's subscription. Re-inviting an
   * already-pending email just resends the email; no duplicate row.
   */
  async createInvite(
    inviterId: string,
    rawEmail: string,
  ): Promise<{ message: string }> {
    const email = this.users.normalizeEmail(rawEmail);

    const inviter = await this.users.findById(inviterId);
    if (!inviter) throw new NotFoundException('Inviter not found');
    if (email === inviter.email) {
      throw new BadRequestException("You can't invite yourself.");
    }

    const existingUser = await this.users.findByEmail(email);
    if (existingUser) {
      throw new BadRequestException('This person already has an account.');
    }

    const existingInvite = await this.prisma.invite.findFirst({
      where: { inviterId, email },
    });
    if (!existingInvite) {
      await this.prisma.invite.create({ data: { inviterId, email } });
    }

    await this.email.sendInviteEmail(email, inviter.fullName);
    return { message: 'Invitation sent.' };
  }

  listInvites(inviterId: string) {
    return this.prisma.invite.findMany({
      where: { inviterId },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        acceptedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
