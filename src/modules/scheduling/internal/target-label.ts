import { UsersService } from '../../users/users.service';
import { WithdrawalsService } from '../../withdrawals/withdrawals.service';

interface LabelledTarget {
  userId: string;
  recipientUserId: string | null;
  bankAccountId: string | null;
}

// What the sender is told the money goes to: a username, or a bank name with
// the last four digits. Never the full account number.
export async function targetLabel(
  usersService: UsersService,
  withdrawalsService: WithdrawalsService,
  target: LabelledTarget,
): Promise<string> {
  if (target.recipientUserId) {
    return (await usersService.findById(target.recipientUserId)).username;
  }
  return (
    (await withdrawalsService.getBankAccountLabel(
      target.userId,
      target.bankAccountId!,
    )) ?? 'a bank account that is no longer saved'
  );
}
