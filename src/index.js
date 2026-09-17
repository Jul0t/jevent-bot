import tls from "node:tls";
import {
  Client,
  GatewayIntentBits
} from "discord.js";

const twitchUsername =
  process.env.TWITCH_BOT_USERNAME;

const twitchToken =
  process.env.TWITCH_BOT_OAUTH_TOKEN;

const channels =
  String(
    process.env.TWITCH_CHANNELS ?? ""
  )
    .split(",")
    .map(channel =>
      channel.trim().toLowerCase()
    )
    .filter(Boolean);

if (!twitchUsername || !twitchToken) {
  throw new Error(
    "TWITCH_BOT_USERNAME ou TWITCH_BOT_OAUTH_TOKEN manque."
  );
}

if (channels.length === 0) {
  throw new Error(
    "TWITCH_CHANNELS est vide."
  );
}

const stats = new Map();

function getDateKey() {
  const parts =
    new Intl.DateTimeFormat(
      "fr-FR",
      {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(new Date());

  const values = Object.fromEntries(
    parts
      .filter(part =>
        part.type !== "literal"
      )
      .map(part => [
        part.type,
        part.value
      ])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getChannelStats(channel) {
  const key =
    `${channel}:${getDateKey()}`;

  if (!stats.has(key)) {
    stats.set(key, {
      channel,
      date: getDateKey(),
      messages: 0,
      emotes: 0
    });
  }

  return stats.get(key);
}

function countEmotes(tags) {
  const emotes =
    tags.match(/emotes=([^;]*)/)?.[1] ?? "";

  if (!emotes) {
    return 0;
  }

  return emotes
    .split("/")
    .reduce((total, group) => {
      const separator =
        group.indexOf(":");

      if (separator === -1) {
        return total;
      }

      const positions =
        group.slice(separator + 1);

      return total +
        positions
          .split(",")
          .filter(Boolean)
          .length;
    }, 0);
}

function parseTags(value) {
  const tags = {};

  for (const item of value.split(";")) {
    const separator =
      item.indexOf("=");

    if (separator < 0) {
      tags[item] = "";
      continue;
    }

    tags[item.slice(0, separator)] =
      item.slice(separator + 1);
  }

  return tags;
}

function handleTwitchLine(line) {
  if (line === "PING :tmi.twitch.tv") {
    twitchSocket?.write(
      "PONG :tmi.twitch.tv\r\n"
    );

    return;
  }

  const match =
    line.match(
      /^(?:@([^ ]+) )?:([^ ]+) PRIVMSG #([^ ]+) :(.*)$/
    );

  if (!match) {
    return;
  }

  const tags =
    parseTags(match[1] ?? "");

  const channel =
    match[3].toLowerCase();

  const message =
    match[4];

  const channelStats =
    getChannelStats(channel);

  channelStats.messages += 1;
  channelStats.emotes +=
    countEmotes(match[1] ?? "");

  console.log(
    `[Twitch] #${channel} ` +
    `${tags["display-name"] ?? "?"}: ` +
    `${message}`
  );
}

let twitchSocket = null;

function connectTwitch() {
  twitchSocket = tls.connect({
    host: "irc.chat.twitch.tv",
    port: 6697,
    servername: "irc.chat.twitch.tv",
    rejectUnauthorized: true
  }, () => {
    console.log(
      "[Twitch] Connexion établie."
    );

    twitchSocket.write(
      `PASS ${twitchToken}\r\n`
    );

    twitchSocket.write(
      `NICK ${twitchUsername}\r\n`
    );

    twitchSocket.write(
      "CAP REQ :twitch.tv/tags " +
      "twitch.tv/commands\r\n"
    );

    for (const channel of channels) {
      twitchSocket.write(
        `JOIN #${channel}\r\n`
      );
    }

    console.log(
      `[Twitch] Chaînes : ${channels.join(", ")}`
    );
  }
  );

  let buffer = "";

  twitchSocket.on(
    "data",
    data => {
      buffer += data.toString();

      const lines =
        buffer.split("\r\n");

      buffer =
        lines.pop() ?? "";

      for (const line of lines) {
        if (line) {
          handleTwitchLine(line);
        }
      }
    }
  );

  twitchSocket.on(
    "error",
    error => {
      console.error(
        "[Twitch] Erreur :",
        error.message
      );
    }
  );

  twitchSocket.on(
    "close",
    () => {
      console.log(
        "[Twitch] Déconnexion. Reconnexion dans 5 secondes."
      );

      setTimeout(
        connectTwitch,
        5000
      );
    }
  );
}

function printStats() {
  console.log(
    "[Stats]",
    JSON.stringify(
      [...stats.values()]
    )
  );
}

connectTwitch();

setInterval(
  printStats,
  60_000
);

/*
 * Le bot Discord reste optionnel pour le moment.
 * Si DISCORD_TOKEN est configuré, il se connecte.
 */
if (process.env.DISCORD_TOKEN) {
  const discord =
    new Client({
      intents: [
        GatewayIntentBits.Guilds
      ]
    });

  discord.once(
    "ready",
    client => {
      console.log(
        `[Discord] Connecté comme ${client.user.tag}.`
      );
    }
  );

  discord.login(
    process.env.DISCORD_TOKEN
  );
}