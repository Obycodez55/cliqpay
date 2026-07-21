import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { runInTransaction } from '../../database/transaction.util';
import { LedgerService } from '../ledger/ledger.service';
import { User } from './entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import {
  RegisterResponseDto,
  toRegisterResponse,
} from './dto/register-response.dto';
import { mapUsersUniqueViolation } from './internal/errors';

const BCRYPT_SALT_ROUNDS = 10;
const DEFAULT_WALLET_CURRENCY = 'NGN';

/**
 * The one exported surface of the auth module — see docs/architecture.md
 * §10. Login, sessions, and MFA are later slices; this is registration only.
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledgerService: LedgerService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const { user, wallet } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const userRepo = manager.getRepository(User);
        const user = userRepo.create({
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          username: dto.username,
          phone: dto.phone,
        });

        try {
          await userRepo.save(user);
        } catch (error) {
          mapUsersUniqueViolation(error);
        }

        const wallet = await this.ledgerService.createUserWallet(
          manager,
          user.id,
          DEFAULT_WALLET_CURRENCY,
        );

        return { user, wallet };
      },
    );

    return toRegisterResponse(user, wallet);
  }
}
