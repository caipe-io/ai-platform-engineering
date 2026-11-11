"""Read-only runtime access to a server-seeded skill snapshot."""

from deepagents.backends.protocol import EditResult, FileUploadResponse, WriteResult
from deepagents.backends.store import StoreBackend


class ReadOnlySkillsBackend(StoreBackend):
    """Read and list through StoreBackend while rejecting instruction mutation."""

    def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error="Skill snapshots are read-only")

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        return self.write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        return EditResult(error="Skill snapshots are read-only")

    async def aedit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        return self.edit(file_path, old_string, new_string, replace_all)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [FileUploadResponse(path=path, error="permission_denied") for path, _ in files]

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return self.upload_files(files)
