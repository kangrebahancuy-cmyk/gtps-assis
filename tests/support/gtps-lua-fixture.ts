/**
 * More SYNTHETIC documentation for the script-generator tests: the topics the generator searches for
 * (commands, rewards, inventory, storage, shops, timers, moderation, mailbox, item callbacks).
 * Names, signatures and wording are INVENTED for these tests. They say nothing about the real GTPS Cloud API.
 */
import { PAGES, seededDb, type PageSpec } from "./gtps-docs-fixture";

export const GENERATOR_EXTRA_PAGES: PageSpec[] = [
  {
    slug: "commands",
    title: "Chat commands",
    category: ["Guides"],
    sections: [
      { heading: "Chat commands", level: 1, content: "A custom command is a chat message that starts with a slash. Register onPlayerCommandCallback and compare the command name; return true to say that the command was handled." },
    ],
    api: [
      { name: "onPlayerCommandCallback", signature: "onPlayerCommandCallback(function(world, player, command, args)", params: ["world", "player", "command", "args"], returns: "boolean", description: "Called when a player sends a slash command. Return true when handled." },
    ],
    code: [{ context: "A /hello command", code: 'onPlayerCommandCallback(function(world, player, command, args)\n  if command == "hello" then\n    player:onConsoleMessage("Hello!")\n    return true\n  end\n  return false\nend)' }],
  },
  {
    slug: "inventory",
    title: "Inventory",
    category: ["Classes"],
    sections: [{ heading: "Inventory", level: 1, content: "Players carry items. addItem puts items into the inventory of a player, removeItem takes them away, getItemCount tells how many a player has." }],
    api: [
      { name: "Player:addItem", signature: "Player:addItem(itemId, amount)", params: ["itemId", "amount"], returns: "boolean", description: "Adds items to the inventory of the player." },
      { name: "Player:removeItem", signature: "Player:removeItem(itemId, amount)", params: ["itemId", "amount"], returns: "boolean", description: "Removes items from the inventory of the player." },
      { name: "Player:getItemCount", signature: "Player:getItemCount(itemId)", params: ["itemId"], returns: "number", description: "How many of an item the player has." },
    ],
  },
  {
    slug: "storage",
    title: "Storage",
    category: ["Reference"],
    sections: [{ heading: "Storage", level: 1, content: "storage saves data so that it survives a restart. Use it to remember when a player last claimed a daily reward. Keys are strings; values are numbers or strings." }],
    api: [
      { name: "storage.get", signature: "storage.get(key)", params: ["key"], returns: "any", description: "Reads a saved value, or nil." },
      { name: "storage.set", signature: "storage.set(key, value)", params: ["key", "value"], description: "Saves a value." },
      { name: "time.now", signature: "time.now()", params: [], returns: "number", description: "Current server time in seconds since 1970." },
    ],
  },
  {
    slug: "shop",
    title: "Shop and NPC",
    category: ["Classes"],
    sections: [{ heading: "Shop", level: 1, content: "A Shop sells items to players for gems. Create a shop, add offers to it, and open it for a player. An NPC shop is a shop opened when a player talks to the NPC." }],
    api: [
      { name: "Shop:create", signature: "Shop:create(name)", params: ["name"], returns: "Shop", description: "Creates a shop." },
      { name: "Shop:addOffer", signature: "Shop:addOffer(itemId, price)", params: ["itemId", "price"], description: "Adds an item for sale at a price in gems." },
      { name: "Shop:open", signature: "Shop:open(player)", params: ["player"], description: "Shows the shop to a player." },
      { name: "Player:getGems", signature: "Player:getGems()", params: [], returns: "number", description: "The gems the player has." },
    ],
  },
  {
    slug: "broadcast",
    title: "Broadcast",
    category: ["Reference"],
    sections: [{ heading: "Broadcast", level: 1, content: "broadcast sends a message to every player on the server. Use timer.setInterval to repeat an automatic event announcement." }],
    api: [{ name: "broadcast", signature: "broadcast(message)", params: ["message"], description: "Sends a message to all online players." }],
  },
  {
    slug: "moderation",
    title: "Moderation",
    category: ["Classes"],
    sections: [{ heading: "Moderation", level: 1, content: "Moderators can kick or mute a player for a reason. isAdmin tells whether a player has admin rights. Check it before running a moderation command." }],
    api: [
      { name: "Player:kick", signature: "Player:kick(reason)", params: ["reason"], description: "Removes the player from the server." },
      { name: "Player:mute", signature: "Player:mute(minutes)", params: ["minutes"], description: "Stops the player from chatting for some minutes." },
      { name: "Player:isAdmin", signature: "Player:isAdmin()", params: [], returns: "boolean", description: "Whether the player has admin rights." },
    ],
  },
  {
    slug: "mailbox",
    title: "Mailbox",
    category: ["Classes"],
    sections: [{ heading: "Mailbox", level: 1, content: "The mailbox delivers a mail with an optional reward to a player, even when the player is offline. The player collects the reward from the mailbox." }],
    api: [{ name: "Mailbox:send", signature: "Mailbox:send(playerName, subject, itemId, amount)", params: ["playerName", "subject", "itemId", "amount"], returns: "boolean", description: "Sends a mail with an item reward to a player." }],
  },
  {
    slug: "items",
    title: "Item interaction",
    category: ["Guides"],
    sections: [{ heading: "Item interaction", level: 1, content: "onItemActivateCallback runs when a player activates an item on a tile. The handler receives the world, the player, the item id and the tile. Return true to consume the activation." }],
    api: [
      { name: "onItemActivateCallback", signature: "onItemActivateCallback(function(world, player, itemId, tile)", params: ["world", "player", "itemId", "tile"], returns: "boolean", description: "Called when a player activates an item on a tile." },
      { name: "World:setTile", signature: "World:setTile(x, y, itemId)", params: ["x", "y", "itemId"], description: "Places an item on a tile of the world." },
    ],
  },
];

export const GENERATOR_PAGES: PageSpec[] = [...PAGES, ...GENERATOR_EXTRA_PAGES];
export const generatorDb = () => seededDb(GENERATOR_PAGES);
