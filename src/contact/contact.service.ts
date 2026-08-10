import { Injectable } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContactDto } from './dto/contact.dto';

@Injectable()
export class ContactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /** Persists the submission (for the admin view) and still sends the existing SUPPORT_EMAIL notification. */
  async submit(dto: ContactDto): Promise<{ message: string }> {
    await this.prisma.contactMessage.create({
      data: {
        name: dto.name,
        email: dto.email,
        reason: dto.reason,
        message: dto.message,
      },
    });
    await this.email.sendContactFormMessage(
      dto.name,
      dto.email,
      dto.reason,
      dto.message,
    );
    return { message: "Thanks — we'll get back to you soon." };
  }
}
