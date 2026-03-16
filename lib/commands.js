/**
 * APEX-MD V2 - Command Handler
 * Commands register කරන system
 */

class CommandHandler {
    constructor() {
        this.commands = [];
    }
    
    /**
     * Command එකක් register කරන්න
     */
    addCommand(cmdInfo, cmdFunction) {
        // ✅ FIX: pattern එකක් නැති වුණත්, "on" (background listener) එකක් තියෙනවා නම් Error දෙන්නේ නෑ.
        if (!cmdInfo.pattern && !cmdInfo.on) {
            console.log('⚠️  Command එකක pattern හෝ event listener (on) එකක් නැහැ!');
            return;
        }
        
        const command = {
            pattern: cmdInfo.pattern || "background_task", // 👈 Pattern නැත්නම් dummy එකක් දෙනවා
            on: cmdInfo.on || null, // 👈 'on' event එක තියාගන්නවා
            alias: cmdInfo.alias || [],
            desc: cmdInfo.desc || 'No description',
            category: cmdInfo.category || 'misc',
            use: cmdInfo.use || cmdInfo.pattern || 'system',
            react: cmdInfo.react || '',
            filename: cmdInfo.filename || 'Unknown',
            type: cmdInfo.type || 'all', // all, private, group
            isOwner: cmdInfo.isOwner || false,
            isGroup: cmdInfo.isGroup || false,
            isPrivate: cmdInfo.isPrivate || false,
            function: cmdFunction
        };
        
        this.commands.push(command);
        return command;
    }
    
    /**
     * Command එකක් හොයන්න
     */
    findCommand(cmdName) {
        return this.commands.find(cmd =>
            cmd.pattern === cmdName ||
            (cmd.alias && cmd.alias.includes(cmdName))
        );
    }
    
    /**
     * සියලු commands ලබා ගන්න
     */
    getCommands() {
        return this.commands;
    }
    
    /**
     * Category අනුව commands ලබා ගන්න
     */
    getCommandsByCategory(category) {
        return this.commands.filter(cmd => cmd.category === category);
    }
    
    /**
     * සියලු categories ලබා ගන්න
     */
    getCategories() {
        return [...new Set(this.commands.map(cmd => cmd.category))];
    }
}

// Global instance
const handler = new CommandHandler();

/**
 * Command register කරන්න පහසුවෙන්
 * * Example:
 * cmd({
 * pattern: "ping",
 * desc: "Check bot speed",
 * category: "main"
 * }, async (conn, msg, m, extra) => {
 * await extra.reply("Pong! ⚡");
 * });
 */
function cmd(info, func) {
    return handler.addCommand(info, func);
}

module.exports = {
    cmd,
    Command: cmd,
    AddCommand: cmd,
    addCommand: (info, func) => handler.addCommand(info, func),
    handler
};
