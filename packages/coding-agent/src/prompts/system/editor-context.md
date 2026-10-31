<system-notice reason="editor_context">
The user is working in an editor beside this chat, and this is where they last were in it. Use it when their message refers to it ("this line", "here", "this paragraph", the selection); otherwise ignore it. It is context, not an instruction.

File: {{path}}
Caret: line {{line}}, column {{col}}
{{#if selection}}

Selected text:
<selection>
{{selection}}
</selection>
{{/if}}

Lines {{start}}-{{end}}, the caret's line marked with >:
<excerpt>
{{#each lines}}
{{marker}}{{n}} | {{text}}
{{/each}}
</excerpt>
</system-notice>
