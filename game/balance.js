const fs = require("fs");
const path = require("path");

function loadBalance() {
  const p = path.join(__dirname, "balance.json");
  const raw = fs.readFileSync(p, "utf-8");
  const bal = JSON.parse(raw);

  // --- basic validation (최소한만) ---
  if (!bal.cards?.weaponsBase?.length) throw new Error("balance.json: cards.weaponsBase missing");
  if (!bal.cards?.armorsBase?.length) throw new Error("balance.json: cards.armorsBase missing");
  if (!bal.turnFlow?.openSlots) throw new Error("balance.json: turnFlow.openSlots missing");

  // --- build fast lookup sets ---
  const weaponSet = new Set();
  const armorSet = new Set();

  for (const c of bal.cards.weaponsBase) weaponSet.add(c);
  for (const c of bal.cards.armorsBase) armorSet.add(c);

  // upgraded: c/b fixed
  weaponSet.add(bal.cards.upgraded.weapon.c);
  weaponSet.add(bal.cards.upgraded.weapon.b);
  armorSet.add(bal.cards.upgraded.armor.c);
  armorSet.add(bal.cards.upgraded.armor.b);

  // upgraded: a maps
  for (const v of Object.values(bal.cards.upgraded.weapon.a || {})) weaponSet.add(v);
  for (const v of Object.values(bal.cards.upgraded.armor.a || {})) armorSet.add(v);

  // public balance for client (client가 알아야 할 것만)
  const publicBalance = {
    hp: bal.hp,
    colors: bal.colors,
    cards: bal.cards,
    upgradeRules: bal.upgradeRules,
    turnFlow: bal.turnFlow,
    combat: bal.combat,
    multiplier: bal.multiplier,
    rps: bal.rps
  };

  return {
    bal,
    publicBalance,
    weaponSet,
    armorSet
  };
}

const BALANCE = loadBalance();

module.exports = {
  BAL: BALANCE.bal,
  PUBLIC_BAL: BALANCE.publicBalance,
  WEAPON_SET: BALANCE.weaponSet,
  ARMOR_SET: BALANCE.armorSet
};