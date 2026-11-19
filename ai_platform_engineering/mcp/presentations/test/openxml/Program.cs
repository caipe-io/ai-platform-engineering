using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using System.Text.Json;

if (args.Length == 0) throw new ArgumentException("Provide presentation paths to validate.");
foreach (var path in args)
{
    try
    {
        using var document = PresentationDocument.Open(path, false);
        var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365) { MaxNumberOfErrors = 200 };
        var errors = validator.Validate(document).Select(error => new
        {
            error.Id,
            error.Description,
            Part = error.Part?.Uri.ToString(),
            Path = error.Path?.XPath,
        }).ToList();
        Console.WriteLine(JsonSerializer.Serialize(new { File = Path.GetFileName(path), Count = errors.Count, Errors = errors }));
        if (errors.Count > 0) Environment.ExitCode = 1;
    }
    catch (Exception error)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { File = Path.GetFileName(path), Error = error.Message }));
        Environment.ExitCode = 1;
    }
}
