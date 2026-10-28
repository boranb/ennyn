// GitHub's reading of a workflow file, by GitHub's own code (actions/runner, src/Sdk/WorkflowParser): for each cell
// on stdin ([{"id","text"}]), the YAML as the workflow parser's YamlObjectReader gives it, anchors allowed (aliases
// replayed as it replays them), and the errors WorkflowTemplateParser.LoadWorkflow finds in the file as a workflow.
// The assembly is named Test: the SDK opens its internals to that name. It runs with no network and no file but
// its own; test/reference/actions-yaml.mjs builds and runs it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using GitHub.Actions.WorkflowParser;
using GitHub.Actions.WorkflowParser.Conversion;
using GitHub.Actions.WorkflowParser.ObjectTemplating;
using GitHub.Actions.WorkflowParser.ObjectTemplating.Tokens;

sealed class OneFile : IFileProvider
{
    private readonly string m_text;
    public OneFile(string text) { m_text = text; }
    public string GetFileContent(string path) => path == ".github/workflows/w.yml" ? m_text : throw new FileNotFoundException(path);
    public string ResolvePath(string defaultRoot, string path) => path;
}

static class Program
{
    static JsonNode Node(YamlObjectReader r)
    {
        if (r.AllowLiteral(out LiteralToken lit))
        {
            var t = lit is StringToken ? "s" : lit is BooleanToken ? "b" : lit is NumberToken ? "n" : lit is NullToken ? "0" : "?";
            var v = lit is StringToken s ? s.Value : lit.ToString();
            return new JsonObject { ["l"] = lit.Line, ["t"] = t, ["v"] = v };
        }
        if (r.AllowSequenceStart(out SequenceToken seq))
        {
            var items = new JsonArray();
            while (!r.AllowSequenceEnd()) items.Add(Node(r));
            return new JsonObject { ["l"] = seq.Line, ["q"] = items };
        }
        if (r.AllowMappingStart(out MappingToken map))
        {
            var pairs = new JsonArray();
            while (!r.AllowMappingEnd()) pairs.Add(new JsonArray(Node(r), Node(r)));
            return new JsonObject { ["l"] = map.Line, ["m"] = pairs };
        }
        throw new InvalidOperationException("no node where one was expected");
    }

    static void Main()
    {
        var cells = JsonNode.Parse(Console.In.ReadToEnd())!.AsArray();
        var output = new JsonArray();
        foreach (var cell in cells)
        {
            var id = (string)cell!["id"]!;
            var text = (string)cell["text"]!;
            var result = new JsonObject { ["id"] = id };
            try
            {
                var r = new YamlObjectReader(1, new StringReader(text), allowAnchors: true);
                r.ValidateStart();
                var tree = Node(r);
                r.ValidateEnd();
                result["yaml"] = tree;
            }
            catch (Exception e)
            {
                result["yamlError"] = e.GetType().Name + ": " + e.Message;
            }
            try
            {
                var parser = new WorkflowTemplateParser(null, null, new ParseOptions { AllowAnchors = true, SkipReusableWorkflows = true }, WorkflowFeatures.GetDefaults());
                var wf = parser.LoadWorkflow(new OneFile(text), ".github/workflows/w.yml", WorkflowConstants.PermissionsPolicy.LimitedRead, new Dictionary<string, ReferencedWorkflow>(), CancellationToken.None);
                result["workflow"] = new JsonArray(wf.Errors.Select(x => (JsonNode)JsonValue.Create(x.Message ?? "")!).ToArray());
            }
            catch (Exception e)
            {
                result["workflow"] = new JsonArray(JsonValue.Create(e.GetType().Name + ": " + e.Message));
            }
            output.Add(result);
        }
        Console.Out.Write(output.ToJsonString());
    }
}
