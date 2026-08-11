import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenPayload } from '../auth/types/jwt-payload.interface';
import { Role } from '../../generated/prisma/enums';
import { AdminService } from './admin.service';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { ListFlaggedSessionsQueryDto } from './dto/list-flagged-sessions-query.dto';
import { ListSubscriptionsQueryDto } from './dto/list-subscriptions-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { CreateLeadDto } from '../leads/dto/create-lead.dto';
import { ListLeadsQueryDto } from '../leads/dto/list-leads-query.dto';
import { UpdateLeadDto } from '../leads/dto/update-lead.dto';
import { ListContactMessagesQueryDto } from '../contact/dto/list-contact-messages-query.dto';
import { ReplyContactMessageDto } from '../contact/dto/reply-contact-message.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { SetDirectoryAccessDto } from './dto/set-directory-access.dto';
import { SetLeadFinderAccessDto } from './dto/set-lead-finder-access.dto';
import { ListProspectsQueryDto } from './dto/list-prospects-query.dto';
import { InviteProspectDto } from './dto/invite-prospect.dto';
import { BulkInviteProspectsDto } from './dto/bulk-invite-prospects.dto';
import { PitchProspectDto } from './dto/pitch-prospect.dto';

/** Every route here requires ADMIN or SUPER_ADMIN — JwtAuthGuard (global) authenticates, RolesGuard authorizes. */
@ApiTags('admin')
@UseGuards(RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.admin.listUsers(query);
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Get('users/:id/sessions')
  getUserSessions(@Param('id') id: string) {
    return this.admin.getUserSessions(id);
  }

  @Post('users/:id/suspend')
  suspendUser(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
  ) {
    return this.admin.suspendUser(admin.sub, id, dto.reason);
  }

  @Post('users/:id/reactivate')
  reactivateUser(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.reactivateUser(admin.sub, id);
  }

  @Post('users/:id/send-password-reset')
  sendPasswordReset(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.sendPasswordReset(admin.sub, id);
  }

  @Delete('users/:id')
  deleteUser(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.deleteUser(admin.sub, id);
  }

  @Post('users/:id/force-logout')
  forceLogout(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.forceLogout(admin.sub, id);
  }

  @Post('users/:id/impersonate')
  impersonateUser(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.impersonateUser(admin.sub, id);
  }

  @Post('users/invite')
  inviteUser(
    @CurrentUser() admin: AccessTokenPayload,
    @Body() dto: InviteUserDto,
  ) {
    return this.admin.inviteUser(admin.sub, dto);
  }

  @Patch('users/:id/directory-access')
  setDirectoryAccess(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
    @Body() dto: SetDirectoryAccessDto,
  ) {
    return this.admin.setDirectoryAccess(admin.sub, id, dto);
  }

  @Patch('users/:id/lead-finder-access')
  setLeadFinderAccess(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
    @Body() dto: SetLeadFinderAccessDto,
  ) {
    return this.admin.setLeadFinderAccess(admin.sub, id, dto);
  }

  @Get('prospects')
  listProspects(@Query() query: ListProspectsQueryDto) {
    return this.admin.listProspects(query);
  }

  @Post('prospects/:id/pitch')
  pitchProspect(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
    @Body() dto: PitchProspectDto,
  ) {
    return this.admin.pitchProspect(admin.sub, id, dto);
  }

  @Post('prospects/invite')
  inviteProspect(
    @CurrentUser() admin: AccessTokenPayload,
    @Body() dto: InviteProspectDto,
  ) {
    return this.admin.inviteProspect(admin.sub, dto);
  }

  @Post('prospects/invite-bulk')
  inviteProspectsBulk(
    @CurrentUser() admin: AccessTokenPayload,
    @Body() dto: BulkInviteProspectsDto,
  ) {
    return this.admin.inviteProspectsBulk(admin.sub, dto);
  }

  @Get('subscriptions')
  listSubscriptions(@Query() query: ListSubscriptionsQueryDto) {
    return this.admin.listSubscriptions(query);
  }

  @Get('lead-finder-subscriptions')
  listLeadFinderSubscriptions(@Query() query: ListSubscriptionsQueryDto) {
    return this.admin.listLeadFinderSubscriptions(query);
  }

  @Get('billing/monthly')
  getMonthlyRevenue() {
    return this.admin.getMonthlyRevenue();
  }

  @Get('audit-logs')
  listAuditLogs(@Query() query: ListAuditLogsQueryDto) {
    return this.admin.listAuditLogs(query);
  }

  @Get('security/sessions')
  listFlaggedSessions(@Query() query: ListFlaggedSessionsQueryDto) {
    return this.admin.listFlaggedSessions(query);
  }

  @Get('leads')
  listLeads(@Query() query: ListLeadsQueryDto) {
    return this.admin.listLeads(query);
  }

  @Get('leads/filters')
  getLeadFilters() {
    return this.admin.getLeadFilters();
  }

  @Post('leads')
  createLead(
    @CurrentUser() admin: AccessTokenPayload,
    @Body() dto: CreateLeadDto,
  ) {
    return this.admin.createLead(admin.sub, dto);
  }

  @Patch('leads/:id')
  updateLead(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    return this.admin.updateLead(admin.sub, id, dto);
  }

  @Post('leads/:id/approve')
  approveLead(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.approveLead(admin.sub, id);
  }

  @Delete('leads/:id')
  deleteLead(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.deleteLead(admin.sub, id);
  }

  @Get('contact-messages')
  listContactMessages(@Query() query: ListContactMessagesQueryDto) {
    return this.admin.listContactMessages(query);
  }

  @Post('contact-messages/:id/resolve')
  resolveContactMessage(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.resolveContactMessage(admin.sub, id);
  }

  @Delete('contact-messages/:id')
  deleteContactMessage(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
  ) {
    return this.admin.deleteContactMessage(admin.sub, id);
  }

  @Post('contact-messages/:id/reply')
  replyToContactMessage(
    @CurrentUser() admin: AccessTokenPayload,
    @Param('id') id: string,
    @Body() dto: ReplyContactMessageDto,
  ) {
    return this.admin.replyToContactMessage(admin.sub, id, dto);
  }
}
