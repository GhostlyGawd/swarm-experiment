// An executable product specification (FR-2.1).
//
// Written by the Specifier persona. Every rule below compiles into three
// things at once: contract clauses the Tier-2 verifier must discharge before
// any implementation ships, enforcement artifacts for each named layer, and a
// provenance record so every node derived from the rule can be found again
// when the rule changes.
//
//   aether spec examples/ledger.spec

spec ledger {
  rule "A transfer may not overdraw the sender" on transfer {
    given sender.balance >= amount;
    given amount > 0n;
    then  sender.balance >= 0n;
    changes sender.balance, receiver.balance;
    enforce client, gateway, persistence;
    because "An overdraft becomes an audited accounting discrepancy, not an error.";
    guard architectural;
  }

  rule "Transfers conserve money" on transfer {
    then sender.balance + receiver.balance === old(sender.balance) + old(receiver.balance);
    enforce gateway;
    rigor formal;
  }

  rule "A fee never exceeds the amount it is charged on" on feeFor {
    given gross >= 0n;
    then  result <= gross;
    enforce gateway, client;
    because "A fee larger than the transaction is a billing incident, not a rounding one.";
  }
}
