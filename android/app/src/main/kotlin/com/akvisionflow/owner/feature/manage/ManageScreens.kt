package com.akvisionflow.owner.feature.manage

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.akvisionflow.owner.core.data.SessionContext

const val MANAGE_SEARCH_TAG = "manage_search"
const val APPROVE_BUTTON_TAG = "approve_button"
const val REJECT_BUTTON_TAG = "reject_button"
const val DECISION_MESSAGE_TAG = "decision_message"

/** The hub: one card per area this session may open (its permission decides), approvals last. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManageHubScreen(context: SessionContext?, onOpen: (ManageKind) -> Unit, modifier: Modifier = Modifier) {
    val kinds = visibleKinds(context)
    Scaffold(modifier = modifier, topBar = { TopAppBar(title = { Text("Manage") }) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (kinds.isEmpty()) item { Text("Your role has no management areas in the app.") }
            items(kinds) { kind ->
                Card(Modifier.fillMaxWidth().clickable { onOpen(kind) }) {
                    Column(Modifier.padding(16.dp)) {
                        Text(kind.label, style = MaterialTheme.typography.titleMedium)
                        Text(if (kind.isApprovalKind) "Waiting for a decision" else "Search and open details", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManageListScreen(kind: ManageKind, viewModel: ManageListViewModel, onOpen: (String) -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsState()
    Scaffold(modifier = modifier, topBar = { TopAppBar(title = { Text(kind.label) }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (kind.searchable) {
                OutlinedTextField(
                    value = state.search,
                    onValueChange = viewModel::onSearchChanged,
                    label = { Text("Search ${kind.label.lowercase()}") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag(MANAGE_SEARCH_TAG),
                )
            }
            state.errorMessage?.let { msg ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(msg, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = viewModel::retry) { Text("Retry") }
                }
            }
            when {
                state.isLoading && state.rows.isEmpty() -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) { CircularProgressIndicator() }
                state.loaded && state.rows.isEmpty() -> Text(if (kind.isApprovalKind) "Nothing is waiting for a decision." else "Nothing found.", modifier = Modifier.padding(16.dp))
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(state.rows, key = { it.id }) { row ->
                        RowItem(row) { onOpen(row.id) }
                        HorizontalDivider()
                    }
                    item {
                        if (state.hasMore) {
                            LaunchedEffect(state.rows.size) { viewModel.loadMore() }
                            Box(Modifier.fillMaxWidth().padding(16.dp)) { CircularProgressIndicator(Modifier.align(Alignment.Center)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Box(modifier: Modifier, content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit) = androidx.compose.foundation.layout.Box(modifier, content = content)

@Composable
private fun RowItem(row: Row, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.weight(1f)) {
            Text(row.title, style = MaterialTheme.typography.bodyLarge)
            row.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
        Column(horizontalAlignment = Alignment.End) {
            row.trailing?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            row.status?.let { Text(statusLabel(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary) }
        }
    }
}

internal fun statusLabel(status: String): String = status.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManageDetailScreen(
    kind: ManageKind,
    viewModel: ManageDetailViewModel,
    context: SessionContext?,
    online: Boolean,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsState()
    var confirmApprove by remember { mutableStateOf(false) }
    var rejecting by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    val detail = state.detail

    Scaffold(modifier = modifier, topBar = { TopAppBar(title = { Text(detail?.title ?: kind.label) }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                state.isLoading && detail == null -> CircularProgressIndicator()
                detail == null -> {
                    Text(state.errorMessage ?: "Could not load this.", color = MaterialTheme.colorScheme.error)
                    Button(onClick = viewModel::load) { Text("Retry") }
                }
                else -> {
                    detail.status?.let { Text(statusLabel(it), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.secondary) }
                    state.errorMessage?.let { Text("$it (showing what was loaded)", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    detail.fields.forEach { f ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(f.label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
                            Text(f.value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 16.dp))
                        }
                    }
                    detail.sections.forEach { section ->
                        Text(section.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
                        section.lines.forEach { l ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Column(Modifier.weight(1f)) {
                                    Text(l.title, style = MaterialTheme.typography.bodyMedium)
                                    l.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                }
                                l.amount?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            }
                        }
                    }

                    when (val o = state.outcome) {
                        is DecisionOutcome.Done -> Text(if (o.approved) "Approved." else "Rejected.", modifier = Modifier.testTag(DECISION_MESSAGE_TAG))
                        DecisionOutcome.AlreadyDecided -> Text("Somebody else has already decided this. Nothing was changed by your action - the current state is shown.", color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag(DECISION_MESSAGE_TAG))
                        is DecisionOutcome.Refused -> Text(o.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag(DECISION_MESSAGE_TAG))
                        null -> Unit
                    }

                    if (canDecide(context, detail)) {
                        if (!online) Text("Approvals need a connection: they are never saved for later, because the document may change meanwhile.", style = MaterialTheme.typography.bodySmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Button(onClick = { confirmApprove = true }, enabled = online && !state.isDeciding, modifier = Modifier.weight(1f).testTag(APPROVE_BUTTON_TAG)) { Text("Approve") }
                            OutlinedButton(onClick = { rejecting = true }, enabled = online && !state.isDeciding, modifier = Modifier.weight(1f).testTag(REJECT_BUTTON_TAG)) { Text("Reject") }
                        }
                    }
                }
            }
        }
    }

    if (confirmApprove) {
        AlertDialog(
            onDismissRequest = { confirmApprove = false },
            title = { Text("Approve ${detail?.title ?: ""}?") },
            text = { Text("This records your approval and cannot be undone from the app.") },
            confirmButton = { TextButton(onClick = { confirmApprove = false; viewModel.approve() }) { Text("Approve") } },
            dismissButton = { TextButton(onClick = { confirmApprove = false }) { Text("Cancel") } },
        )
    }
    if (rejecting) {
        AlertDialog(
            onDismissRequest = { rejecting = false },
            title = { Text("Reject ${detail?.title ?: ""}?") },
            text = { OutlinedTextField(value = reason, onValueChange = { reason = it }, label = { Text("Reason (required)") }, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(enabled = reason.isNotBlank(), onClick = { rejecting = false; viewModel.reject(reason); reason = "" }) { Text("Reject") } },
            dismissButton = { TextButton(onClick = { rejecting = false }) { Text("Cancel") } },
        )
    }
}
